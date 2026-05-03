/**
 * Read-only management HTTP server bound to 127.0.0.1 only. Auth via
 * `FLOPSY_MGMT_TOKEN`; unset = accept any loopback request.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '@flopsy/shared';
import type { ChatHandler } from './chat-handler';

const log = createLogger('mgmt-server');

/** Unset → schedule routes return 501. */
export interface ScheduleMgmtHandlers {
    create(
        body: unknown,
    ): Promise<{ ok: true; id: string; message: string } | { ok: false; error: string }>;
    remove(id: string): { ok: boolean; message?: string };
    setEnabled(id: string, enabled: boolean): { ok: boolean; message?: string };
    list(): Array<Record<string, unknown>>;
}

export interface MgmtServerOptions {
    readonly host?: string;
    readonly port: number;
    readonly token?: string;
    readonly snapshotFn: () => unknown;
    readonly pingFn?: () => Record<string, unknown>;
    readonly scheduleHandlers?: ScheduleMgmtHandlers;
    readonly tasksFn?: (query: URLSearchParams) => unknown;
    readonly dndHandlers?: {
        status(): Promise<unknown>;
        setDnd(body: { durationMs: number; reason?: string }): Promise<unknown>;
        clearDnd(): Promise<void>;
        setQuietHours(body: { untilMs: number }): Promise<unknown>;
    };
    readonly proactiveStatsHandlers?: {
        getStats(windowMs: number): Promise<unknown>;
        getFires(id: string, limit: number): unknown;
    };
    readonly chatHandler?: ChatHandler;
}

export class MgmtServer {
    private server: Server | null = null;
    private readonly opts: MgmtServerOptions;
    private startedAt = Date.now();

    constructor(opts: MgmtServerOptions) {
        this.opts = opts;
    }

    async start(): Promise<void> {
        const { host = '127.0.0.1', port } = this.opts;
        this.startedAt = Date.now();
        this.server = createServer((req, res) => {
            this.onRequest(req, res).catch((err) => {
                log.error({ err }, 'mgmt request handler threw');
                if (!res.headersSent) {
                    this.reply(res, 500, {
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            });
        });
        if (this.opts.chatHandler) {
            const ch = this.opts.chatHandler;
            this.server.on('upgrade', (req, socket, head) => {
                ch.handleUpgrade(req, socket as import('node:net').Socket, head as Buffer);
            });
        }
        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(port, host, () => resolve());
        });
        log.info({ host, port, auth: this.opts.token ? 'bearer' : 'open', chat: !!this.opts.chatHandler }, 'mgmt server listening');
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        this.server = null;
    }

    private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        // Bearer token check — when FLOPSY_MGMT_TOKEN is set, require it
        // on every non-ping request. Ping stays open so `flopsy mgmt
        // ping` works before the user sets a token.
        let path: string;
        let query: URLSearchParams;
        try {
            const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
            path = parsed.pathname;
            query = parsed.searchParams;
        } catch {
            return this.reply(res, 400, { error: 'bad-request' });
        }

        if (this.opts.token && path !== '/mgmt/ping') {
            const auth = req.headers['authorization'] ?? '';
            if (!isValidBearer(auth, this.opts.token)) {
                return this.reply(res, 401, { error: 'unauthorized' });
            }
        }

        if (req.method === 'GET' && path === '/mgmt/ping') {
            return this.reply(
                res,
                200,
                this.opts.pingFn
                    ? this.opts.pingFn()
                    : { ok: true, uptimeMs: Date.now() - this.startedAt },
            );
        }

        if (req.method === 'GET' && path === '/mgmt/status') {
            try {
                return this.reply(res, 200, this.opts.snapshotFn());
            } catch (err) {
                return this.reply(res, 500, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        const dnd = this.opts.dndHandlers;
        if (dnd && path.startsWith('/mgmt/dnd')) {
            try {
                if (req.method === 'GET' && path === '/mgmt/dnd') {
                    return this.reply(res, 200, await dnd.status());
                }
                if (req.method === 'POST' && path === '/mgmt/dnd/on') {
                    const body = (await readJsonBody(req)) as {
                        durationMs?: number;
                        reason?: string;
                    };
                    if (typeof body.durationMs !== 'number' || body.durationMs <= 0) {
                        return this.reply(res, 400, { error: 'durationMs > 0 required' });
                    }
                    return this.reply(res, 200, await dnd.setDnd(body as { durationMs: number; reason?: string }));
                }
                if (req.method === 'POST' && path === '/mgmt/dnd/off') {
                    await dnd.clearDnd();
                    return this.reply(res, 200, { ok: true, message: 'DND cleared' });
                }
                if (req.method === 'POST' && path === '/mgmt/dnd/quiet') {
                    const body = (await readJsonBody(req)) as { untilMs?: number };
                    if (typeof body.untilMs !== 'number' || body.untilMs <= Date.now()) {
                        return this.reply(res, 400, { error: 'untilMs must be a future epoch-ms' });
                    }
                    return this.reply(res, 200, await dnd.setQuietHours(body as { untilMs: number }));
                }
            } catch (err) {
                return this.reply(res, 500, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            return this.reply(res, 405, { error: 'method not allowed', path });
        }

        const proactive = this.opts.proactiveStatsHandlers;
        if (proactive && path.startsWith('/mgmt/proactive')) {
            if (req.method === 'GET' && path === '/mgmt/proactive/stats') {
                const windowMs = Number(query.get('windowMs') ?? 86_400_000);
                return this.reply(res, 200, await proactive.getStats(windowMs));
            }
            const firesMatch = path.match(/^\/mgmt\/proactive\/fires\/([^/]+)$/);
            if (req.method === 'GET' && firesMatch) {
                const id = decodeURIComponent(firesMatch[1]!);
                const limit = Number(query.get('limit') ?? 20);
                return this.reply(res, 200, { fires: proactive.getFires(id, limit) });
            }
            return this.reply(res, 404, { error: 'not found', path });
        }

        if (req.method === 'GET' && path === '/mgmt/tasks') {
            if (!this.opts.tasksFn) {
                return this.reply(res, 501, { error: 'tasks endpoint not wired' });
            }
            try {
                return this.reply(res, 200, this.opts.tasksFn(query));
            } catch (err) {
                return this.reply(res, 500, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        const handlers = this.opts.scheduleHandlers;
        if (path === '/mgmt/schedule' || path.startsWith('/mgmt/schedule/')) {
            if (!handlers) {
                return this.reply(res, 501, { error: 'schedule handlers not wired' });
            }
            return this.handleScheduleRoute(req, res, path, handlers);
        }

        this.reply(res, 404, { error: 'not found', path });
    }

    private async handleScheduleRoute(
        req: IncomingMessage,
        res: ServerResponse,
        path: string,
        h: ScheduleMgmtHandlers,
    ): Promise<void> {
        if (req.method === 'GET' && path === '/mgmt/schedule') {
            return this.reply(res, 200, { schedules: h.list() });
        }
        if (req.method === 'POST' && path === '/mgmt/schedule') {
            const body = await readJsonBody(req).catch((err: unknown) => {
                this.reply(res, 400, {
                    error: err instanceof Error ? err.message : String(err),
                });
                return null;
            });
            if (body === null) return;
            const result = await h.create(body);
            return result.ok
                ? this.reply(res, 201, result)
                : this.reply(res, 400, result);
        }
        const match = path.match(/^\/mgmt\/schedule\/([^/]+)(?:\/(disable|enable))?$/);
        if (match) {
            const id = decodeURIComponent(match[1]!);
            const action = match[2];
            if (req.method === 'DELETE' && !action) {
                const result = h.remove(id);
                return result.ok
                    ? this.reply(res, 200, result)
                    : this.reply(res, 404, result);
            }
            if (req.method === 'POST' && (action === 'disable' || action === 'enable')) {
                const result = h.setEnabled(id, action === 'enable');
                return result.ok
                    ? this.reply(res, 200, result)
                    : this.reply(res, 404, result);
            }
        }
        return this.reply(res, 405, { error: 'method not allowed', path });
    }

    private reply(res: ServerResponse, status: number, body: unknown): void {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
    }
}

const MAX_BODY_BYTES = 256 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    let total = 0;
    const chunks: Buffer[] = [];
    for await (const c of req as AsyncIterable<Buffer>) {
        total += c.length;
        if (total > MAX_BODY_BYTES) {
            throw new Error(`body too large (>${MAX_BODY_BYTES} bytes)`);
        }
        chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (!raw) return {};
    try {
        return JSON.parse(raw) as unknown;
    } catch (err) {
        throw new Error(
            `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

function isValidBearer(authHeader: string, expectedToken: string): boolean {
    const expected = `Bearer ${expectedToken}`;
    if (authHeader.length !== expected.length) return false;
    const a = Buffer.from(authHeader, 'utf-8');
    const b = Buffer.from(expected, 'utf-8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
