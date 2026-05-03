import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { createLogger } from '@flopsy/shared';
import { verifyWebhookSignature, isLoopbackIp, RateLimiter } from './security';

export interface WebhookConfig {
    port: number;
    host?: string;
    secret?: string;
    allowedIps?: string[];
    maxBodyBytes?: number;
}

export type RouteHandler = (
    req: IncomingMessage,
    body: string,
    res: ServerResponse,
) => Promise<void>;

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEDUP_TTL_MS = 3_600_000;
const MAX_DEDUP_ENTRIES = 50_000;

export class WebhookServer {
    readonly log = createLogger('webhook');

    private server: Server | null = null;
    private config: WebhookConfig | null = null;
    private readonly processed = new Map<string, number>();
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;
    private readonly routes = new Map<string, RouteHandler>();
    // Paths registered with `ownsSignature: true` verify their own signature
    // inline; the global-secret check is skipped for these so per-route
    // secrets don't collide with `webhook.secret` from flopsy.json5.
    private readonly routesOwnSignature = new Set<string>();
    private readonly rateLimiter = new RateLimiter();

    registerRoute(
        pathPrefix: string,
        handler: RouteHandler,
        opts?: { ownsSignature?: boolean },
    ): void {
        this.routes.set(pathPrefix, handler);
        if (opts?.ownsSignature) {
            this.routesOwnSignature.add(pathPrefix);
        } else {
            this.routesOwnSignature.delete(pathPrefix);
        }
    }

    unregisterRoute(pathPrefix: string): boolean {
        this.routesOwnSignature.delete(pathPrefix);
        return this.routes.delete(pathPrefix);
    }

    get isRunning(): boolean {
        return this.server !== null;
    }
    get port(): number | undefined {
        return this.config?.port;
    }
    get routeCount(): number {
        return this.routes.size;
    }

    async start(config: WebhookConfig): Promise<void> {
        this.config = config;
        const host = config.host ?? '127.0.0.1';

        this.server = createServer((req, res) => {
            this.handleRequest(req, res).catch((err) => {
                this.log.error({ err }, 'request error');
                this.respond(res, 500, { error: 'Internal server error' });
            });
        });

        this.cleanupInterval = setInterval(() => this.sweepDedup(), 5 * 60_000);
        this.cleanupInterval.unref();

        if (!config.secret) {
            this.log.warn(
                'webhook server starting WITHOUT signature verification — all requests will be accepted unsigned',
            );
        }

        return new Promise((resolve, reject) => {
            this.server!.on('error', reject);
            this.server!.listen(config.port, host, () => {
                this.log.info(
                    { port: config.port, host, routes: [...this.routes.keys()] },
                    'webhook server started',
                );
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.processed.clear();

        if (this.server) {
            return new Promise((resolve) => {
                this.server!.close(() => {
                    this.log.info('webhook server stopped');
                    resolve();
                });
            });
        }
    }

    respond(res: ServerResponse, status: number, data: Record<string, unknown>): void {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = status;
        res.end(JSON.stringify(data));
    }

    parseJson(body: string): unknown {
        try {
            return JSON.parse(body);
        } catch {
            return null;
        }
    }

    private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method === 'GET' && req.url === '/health') {
            return this.respond(res, 200, { status: 'ok' });
        }

        // GET/HEAD on registered paths return 200 for reachability probes
        // (LINE, Slack tools). Unregistered paths 404 to avoid leaking the
        // route table to scanners.
        if (req.method === 'GET' || req.method === 'HEAD') {
            const url = req.url ?? '/';
            const matched = [...this.routes.keys()].some((prefix) => url.startsWith(prefix));
            if (matched) {
                return this.respond(res, 200, {
                    status: 'ok',
                    method: 'POST',
                    info: 'webhook endpoint — send POST with JSON body to deliver an event',
                });
            }
            return this.respond(res, 404, { error: 'Unknown webhook endpoint' });
        }

        if (req.method !== 'POST') {
            return this.respond(res, 405, { error: 'Method not allowed' });
        }

        const clientIp = this.getClientIp(req);
        if (this.config?.allowedIps?.length) {
            if (!this.config.allowedIps.includes(clientIp)) {
                this.log.warn({ ip: clientIp }, 'rejected by ip allowlist');
                return this.respond(res, 403, { error: 'Forbidden' });
            }
        } else if (!isLoopbackIp(clientIp)) {
            this.log.warn({ ip: clientIp }, 'rejected non-loopback (no allowlist configured)');
            return this.respond(res, 403, { error: 'Forbidden' });
        }

        const rateResult = this.rateLimiter.checkRequest(clientIp);
        if (!rateResult.allowed) {
            this.log.warn({ ip: clientIp }, 'webhook rate limited');
            return this.respond(res, 429, { error: 'Too many requests' });
        }

        let body: string;
        try {
            body = await this.readBody(req);
        } catch (err) {
            if (err instanceof Error && err.message === 'body too large') {
                return this.respond(res, 413, { error: 'Request body too large' });
            }
            return this.respond(res, 400, { error: 'Failed to read body' });
        }

        if (!body) {
            return this.respond(res, 400, { error: 'Empty body' });
        }

        // Global signature check skipped when the matched route owns its own
        // signature (route's own secret would 401 against the global secret).
        if (this.config?.secret) {
            const reqUrl = req.url ?? '/';
            const matchedRouteOwnsSig = [...this.routesOwnSignature].some((prefix) =>
                reqUrl.startsWith(prefix),
            );
            if (!matchedRouteOwnsSig) {
                const sigHeader = this.findSignatureHeader(req);
                if (!sigHeader) {
                    this.log.warn('missing webhook signature');
                    return this.respond(res, 401, { error: 'Missing signature' });
                }
                if (!verifyWebhookSignature(this.config.secret, body, sigHeader)) {
                    this.log.warn('invalid webhook signature');
                    return this.respond(res, 401, { error: 'Invalid signature' });
                }
            }
        }

        const requestId = (req.headers['x-request-id'] ??
            req.headers['x-webhook-id'] ??
            req.headers['x-github-delivery']) as string | undefined;
        if (requestId) {
            if (this.isDuplicate(requestId)) {
                return this.respond(res, 200, { status: 'duplicate' });
            }
            this.markProcessed(requestId);
        }

        const url = req.url ?? '/';
        for (const [prefix, handler] of this.routes) {
            if (url.startsWith(prefix)) {
                await handler(req, body, res);
                return;
            }
        }

        this.respond(res, 404, { error: 'Unknown webhook endpoint' });
    }

    private findSignatureHeader(req: IncomingMessage): string | null {
        const candidates = [
            // ─── Generic / Common ──────────────────────────────────────────
            'x-hub-signature-256',
            'x-hub-signature',
            'x-webhook-signature',
            'x-signature',
            'x-signature-256',
            'x-request-signature',
            'x-payload-signature',
            'x-hmac-signature',

            // ─── Standard Webhooks spec (Svix, Clerk, Resend, WorkOS…) ────
            'webhook-signature',
            'webhook-id',
            'webhook-timestamp',

            // ─── Source Control ────────────────────────────────────────────
            'x-gitlab-token', // GitLab

            // ─── CI/CD ─────────────────────────────────────────────────────
            'circleci-signature', // CircleCI
            'signature', // Travis CI (bare — no x- prefix)

            // ─── Payments ──────────────────────────────────────────────────
            'stripe-signature',
            'paddle-signature',
            'x-razorpay-signature',
            'paypal-transmission-sig',
            'paypal-cert-url', // PayPal asymmetric cert retrieval
            'x-square-hmacsha256-signature',
            'x-lemon-squeezy-signature',

            // ─── E-commerce ────────────────────────────────────────────────
            'x-shopify-hmac-sha256',
            'x-wc-webhook-signature', // WooCommerce

            // ─── Messaging / Comms ─────────────────────────────────────────
            'x-slack-signature',
            'x-twilio-signature',
            'x-twilio-email-event-webhook-signature', // SendGrid (ECDSA)
            'x-twilio-email-event-webhook-timestamp', // SendGrid timestamp
            'x-zm-signature', // Zoom
            'x-zoom-signature', // Zoom (alternate)
            'x-line-signature',

            // ─── Email Deliverability ──────────────────────────────────────
            'x-mailgun-signature',
            'x-mailgun-signature-256',
            'x-postmark-signature',

            // ─── Developer / Auth Platforms ────────────────────────────────
            'svix-signature',
            'svix-id',
            'svix-timestamp',

            // ─── Project Management / Productivity ────────────────────────
            'x-linear-signature',
            'x-hook-signature', // Asana
            'x-pagerduty-signature',

            // ─── CRM / Marketing ───────────────────────────────────────────
            'x-hubspot-signature',
            'x-hubspot-signature-v3',
            'x-zendesk-webhook-signature',

            // ─── File Storage ──────────────────────────────────────────────
            'x-dropbox-signature',
            'box-signature-primary',
            'box-signature-secondary',

            // ─── CMS / Content ─────────────────────────────────────────────
            'x-contentful-signature',
            'sanity-webhook-signature',
            'x-webflow-signature',

            // ─── Identity / Auth ───────────────────────────────────────────
            'x-okta-verification-challenge',

            // ─── Scheduling / Forms ────────────────────────────────────────
            'oncehub-signature',
            'typeform-signature',

            // ─── Finance / Fintech ─────────────────────────────────────────
            'x-xero-signature',
            'plaid-verification',
            'moneyhash-signature',

            // ─── Video / Media ─────────────────────────────────────────────
            'mux-signature',

            // ─── Gaming / Social ───────────────────────────────────────────
            'x-signature-ed25519', // Discord (Ed25519 asymmetric)
            'x-signature-timestamp', // Discord (paired with above)

            // ─── DevOps / Cloud ────────────────────────────────────────────
            'x-vercel-signature',

            // ─── APIs / Integration Platforms ──────────────────────────────
            'x-apideck-signature',
            'x-algolia-signature',
        ];
        for (const name of candidates) {
            const value = req.headers[name];
            if (typeof value === 'string') return value;
        }
        return null;
    }

    private async readBody(req: IncomingMessage): Promise<string> {
        const maxBytes = this.config?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let received = 0;
            let settled = false;
            req.on('data', (chunk: Buffer) => {
                received += chunk.length;
                if (received > maxBytes && !settled) {
                    settled = true;
                    reject(new Error('body too large'));
                    req.destroy();
                    return;
                }
                if (!settled) chunks.push(chunk);
            });
            req.on('end', () => {
                if (!settled) {
                    settled = true;
                    resolve(Buffer.concat(chunks).toString());
                }
            });
            req.on('error', (err) => {
                if (!settled) {
                    settled = true;
                    reject(err);
                }
            });
        });
    }

    private getClientIp(req: IncomingMessage): string {
        return req.socket.remoteAddress ?? '';
    }

    private isDuplicate(eventId: string): boolean {
        const expiry = this.processed.get(eventId);
        if (!expiry) return false;
        if (Date.now() > expiry) {
            this.processed.delete(eventId);
            return false;
        }
        return true;
    }

    private markProcessed(eventId: string): void {
        this.processed.set(eventId, Date.now() + DEDUP_TTL_MS);
        if (this.processed.size > MAX_DEDUP_ENTRIES) {
            const oldest = this.processed.keys().next().value;
            if (oldest !== undefined) this.processed.delete(oldest);
        }
    }

    private sweepDedup(): void {
        const now = Date.now();
        for (const [id, expiry] of this.processed) {
            if (now > expiry) this.processed.delete(id);
        }
    }
}
