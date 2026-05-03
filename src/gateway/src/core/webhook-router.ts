import type { IncomingMessage } from 'node:http';
import { createLogger } from '@flopsy/shared';
import { verifyWebhookSignature, sanitize, isSafeIdentifier } from './security';
import type { WebhookServer } from './base-webhook';
import type { MessageRouter } from './message-router';
import type { WebhookSignatureConfig } from './security';

const MAX_EVENT_BODY_LENGTH = 50_000;
const DELIVERY_DEDUP_TTL_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Configuration for an external webhook endpoint (GitHub, Stripe, etc.).
 * Each endpoint gets its own route and pushes events into the agent via
 * the channel worker's EventQueue.
 */
export interface ExternalWebhookConfig {
    /** Unique name for this webhook (used as taskId prefix). */
    name: string;
    /** Route path on the webhook server (e.g. '/webhook/github'). */
    path: string;
    /** Which channel's worker should receive the event. */
    targetChannel: string;
    /**
     * EXACT routing key. When set, delivers to this exact thread and
     * auto-creates the worker if needed (survives daemon restart with no
     * prior user message). When unset, falls back to most-recently-active
     * worker on `targetChannel`.
     */
    targetThread?: string;
    /** Secret for HMAC signature verification. Unsigned requests accepted when unset. */
    secret?: string;
    signature?: {
        header: string;
        algorithm?: 'sha1' | 'sha256' | 'sha512';
        format?: 'hex' | 'base64';
        prefix?: string;
    };
    /** Header name containing the event type (e.g. 'x-github-event'). */
    eventTypeHeader?: string;
    /**
     * Only forward events whose JSON `action` field matches one of these
     * values (case-insensitive). Useful for GitHub/Stripe/Shopify; ignored
     * for providers without an `action` field.
     */
    filterActions?: string[];
    /**
     *   always      — agent always sends a message (default)
     *   conditional — agent decides; only notifies if newsworthy
     *   silent      — no agent turn; event is logged and dropped
     */
    deliveryMode?: 'always' | 'conditional' | 'silent';
    /** Extract a summary from the payload for the agent. */
    transform?: (body: unknown) => string;
}

/**
 * Routes external service webhooks into the agent system via ChannelWorker
 * event queues. Not a messaging channel — one-way notifications.
 */
export class WebhookRouter {
    private readonly log = createLogger('webhook-router');
    private readonly configs: ExternalWebhookConfig[];
    private webhookServer: WebhookServer | null = null;
    private messageRouter: MessageRouter | null = null;
    private readonly runtimeRoutes = new Set<string>();
    // Dedup cache keyed by delivery id (x-github-delivery etc.).
    private readonly recentDeliveries = new Map<string, number>();

    constructor(configs: ExternalWebhookConfig[]) {
        this.configs = configs;
    }

    register(webhookServer: WebhookServer, messageRouter: MessageRouter): void {
        this.webhookServer = webhookServer;
        this.messageRouter = messageRouter;
        for (const cfg of this.configs) {
            this.registerEndpoint(webhookServer, messageRouter, cfg);
        }
    }

    /** Returns false if `register()` hasn't run yet. */
    addRuntimeRoute(cfg: ExternalWebhookConfig): boolean {
        if (!this.webhookServer || !this.messageRouter) return false;
        this.registerEndpoint(this.webhookServer, this.messageRouter, cfg);
        this.runtimeRoutes.add(cfg.path);
        return true;
    }

    /** Returns false for config-defined paths (immutable) or when server is down. */
    removeRuntimeRoute(path: string): boolean {
        if (!this.webhookServer) return false;
        if (!this.runtimeRoutes.has(path)) return false;
        const removed = this.webhookServer.unregisterRoute(path);
        if (removed) this.runtimeRoutes.delete(path);
        return removed;
    }

    private registerEndpoint(
        webhookServer: WebhookServer,
        messageRouter: MessageRouter,
        cfg: ExternalWebhookConfig,
    ): void {
        // Skip the global secret check when this route has its own —
        // otherwise per-route secrets are masked by the global mismatch.
        const ownsSignature = !!(cfg.secret && cfg.signature);
        webhookServer.registerRoute(cfg.path, async (req, body, res) => {
            if (!this.verify(req, body, cfg)) {
                webhookServer.respond(res, 401, { error: `Invalid ${cfg.name} webhook signature` });
                return;
            }

            // Delivery dedup — suppress provider retries of the same event.
            // Status responses are all 2xx (no retries):
            //   200 — agent turn triggered
            //   202 — accepted but won't reach agent (silent / no worker)
            //   204 — suppressed entirely (duplicate / filtered)
            const deliveryId = (
                req.headers['x-github-delivery'] ??
                req.headers['x-delivery-id'] ??
                req.headers['x-request-id']
            ) as string | undefined;
            if (deliveryId) {
                const now = Date.now();
                for (const [k, t] of this.recentDeliveries) {
                    if (now - t > DELIVERY_DEDUP_TTL_MS) this.recentDeliveries.delete(k);
                }
                const dedupKey = `${cfg.name}:${deliveryId}`;
                if (this.recentDeliveries.has(dedupKey)) {
                    this.log.debug({ webhook: cfg.name, deliveryId }, 'duplicate delivery suppressed');
                    webhookServer.respond(res, 204, {});
                    return;
                }
                this.recentDeliveries.set(dedupKey, now);
            }

            const parsed = webhookServer.parseJson(body);
            if (!parsed || typeof parsed !== 'object') {
                webhookServer.respond(res, 400, { error: 'Invalid JSON' });
                return;
            }

            if (cfg.filterActions && cfg.filterActions.length > 0) {
                const action = (parsed as Record<string, unknown>)['action'];
                const allowed = cfg.filterActions.map((a) => a.toLowerCase());
                if (typeof action !== 'string' || !allowed.includes(action.toLowerCase())) {
                    this.log.debug(
                        { webhook: cfg.name, action: action ?? '(none)', allowed },
                        'webhook action filtered — skipping',
                    );
                    webhookServer.respond(res, 204, {});
                    return;
                }
            }

            // Prefer EXACT routing-key delivery; fall back to
            // most-recently-active worker on the channel.
            let worker = cfg.targetThread
                ? messageRouter.getWorker(cfg.targetThread)
                : messageRouter.getWorker(cfg.targetChannel);
            if (!worker && cfg.targetThread) {
                // Cold-start fix: auto-create from the routing key.
                worker = messageRouter.getOrCreateWorkerForKey(cfg.targetThread);
            }
            if (!worker) {
                this.log.warn(
                    { webhook: cfg.name, target: cfg.targetThread ?? cfg.targetChannel },
                    'webhook delivery target not found. Either set --target-thread to a ' +
                    'specific routing-key (preferred for cold-start) or send any message ' +
                    'to the bot on this channel before redelivering.',
                );
                webhookServer.respond(res, 202, { status: 'no-target' });
                return;
            }

            const summary = cfg.transform
                ? cfg.transform(parsed)
                : sanitize(JSON.stringify(parsed, null, 2), MAX_EVENT_BODY_LENGTH);

            const eventType = extractEventType(req, cfg);
            const taskId = `${cfg.name}-${eventType}-${Date.now()}`;

            if (!isSafeIdentifier(taskId)) {
                this.log.warn({ taskId }, 'generated unsafe taskId — dropped');
                webhookServer.respond(res, 202, { status: 'dropped-unsafe-id' });
                return;
            }

            worker.injectEvent({
                type: 'task_complete',
                taskId,
                result: `[${cfg.name}] ${eventType}\n${summary}`,
                completedAt: Date.now(),
                ...(cfg.deliveryMode ? { deliveryMode: cfg.deliveryMode } : {}),
            });

            const isSilent = cfg.deliveryMode === 'silent';
            webhookServer.respond(
                res,
                isSilent ? 202 : 200,
                isSilent ? { status: 'queued-silent' } : { status: 'ok' },
            );

            this.log.info(
                { webhook: cfg.name, event: eventType, target: cfg.targetChannel, silent: isSilent },
                'webhook event routed',
            );
        }, { ownsSignature });

        this.log.debug(
            { webhook: cfg.name, path: cfg.path, target: cfg.targetChannel, ownsSignature },
            'external webhook registered',
        );
    }

    private verify(req: IncomingMessage, body: string, cfg: ExternalWebhookConfig): boolean {
        if (!cfg.secret || !cfg.signature) return true;

        const sig = req.headers[cfg.signature.header.toLowerCase()] as string | undefined;
        if (!sig) return false;

        const sigConfig: WebhookSignatureConfig = {
            algorithm: cfg.signature.algorithm ?? 'sha256',
            format: cfg.signature.format ?? 'hex',
            prefix: cfg.signature.prefix,
        };

        return verifyWebhookSignature(cfg.secret, body, sig, sigConfig);
    }
}

function extractEventType(req: IncomingMessage, cfg: ExternalWebhookConfig): string {
    if (cfg.eventTypeHeader) {
        const value = req.headers[cfg.eventTypeHeader.toLowerCase()] as string | undefined;
        if (value) return value;
    }
    return cfg.name;
}
