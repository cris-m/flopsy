/**
 * Minimal management HTTP server — exposes read-only live state from
 * the running gateway so the CLI can ask questions without restarting.
 *
 * Endpoints:
 *   GET  /mgmt/ping              — {ok, version, uptimeMs}
 *   GET  /mgmt/status            — live status snapshot (the same data
 *                                   the status slash command returns)
 *
 * Bind policy: 127.0.0.1 only — never exposed to the LAN. Auth is via
 * bearer token from env `FLOPSY_MGMT_TOKEN` (optional: when unset the
 * server accepts any localhost request, which is fine for single-user
 * dev since the socket isn't reachable off-box).
 *
 * Keeping this thin on purpose — richer control (start/stop jobs,
 * reconnect channels) lands in Phase 2 once we've validated the auth
 * model + wire format.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '@flopsy/shared';

const log = createLogger('mgmt-server');

/**
 * Bound handlers for mutating proactive schedules from the CLI. The gateway
 * wires these to ProactiveEngine methods; when unset the schedule routes
 * return 501 (feature-not-wired) so the CLI can distinguish "gateway doesn't
 * support this" from "not authorized" / "server not running".
 */
export interface ScheduleMgmtHandlers {
    create(
        body: unknown,
    ): { ok: true; id: string; message: string } | { ok: false; error: string };
    remove(id: string): { ok: boolean; message?: string };
    setEnabled(id: string, enabled: boolean): { ok: boolean; message?: string };
    list(): Array<Record<string, unknown>>;
}

export interface MgmtServerOptions {
    readonly host?: string;
    readonly port: number;
    readonly token?: string;
    /** Called on GET /mgmt/status. Returns a JSON-serializable value. */
    readonly snapshotFn: () => unknown;
    /** Called on GET /mgmt/ping; defaults to process uptime. */
    readonly pingFn?: () => Record<string, unknown>;
    /** Optional schedule handlers; when absent, the schedule routes 501. */
    readonly scheduleHandlers?: ScheduleMgmtHandlers;
    /**
     * Called on GET /mgmt/tasks. Receives the parsed query params
     * (thread, status, limit) and returns a JSON-serializable payload
     * (usually `{ tasks: [...] }`). When absent, /mgmt/tasks responds 501.
     */
    readonly tasksFn?: (query: URLSearchParams) => unknown;
    /**
     * DND handlers. GET /mgmt/dnd → status. POST /mgmt/dnd/on
     * { durationMs, reason? } → enable DND. POST /mgmt/dnd/off → clear.
     * POST /mgmt/dnd/quiet { untilMs } → set quiet hours.
     */
    readonly dndHandlers?: {
        status(): Promise<unknown>;
        setDnd(body: { durationMs: number; reason?: string }): Promise<unknown>;
        clearDnd(): Promise<void>;
        setQuietHours(body: { untilMs: number }): Promise<unknown>;
    };
    /**
     * Proactive stats + fires. GET /mgmt/proactive/stats?windowMs=N returns
     * aggregate counters + per-schedule JobState snapshots. GET
     * /mgmt/proactive/fires/:id?limit=N returns newest-first delivery rows.
     */
    readonly proactiveStatsHandlers?: {
        getStats(windowMs: number): Promise<unknown>;
        getFires(id: string, limit: number): unknown;
    };
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
            // Fire-and-forget on the async handler; any unhandled rejection
            // lands on the node:http default error handler (501), never
            // crashes the server.
            this.onRequest(req, res).catch((err) => {
                log.error({ err }, 'mgmt request handler threw');
                if (!res.headersSent) {
                    this.reply(res, 500, {
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            });
        });
        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(port, host, () => resolve());
        });
        log.info({ host, port, auth: this.opts.token ? 'bearer' : 'open' }, 'mgmt server listening');
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

        // DND routes — thin passthrough to the engine facade. Same
        // auth / token rules as the rest of /mgmt.
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

        // Proactive stats / fires — read-only observability for CLI+chat.
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

        // ── Schedule routes (CLI mutations via manage_schedule handlers) ─
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
        // GET /mgmt/schedule — list
        if (req.method === 'GET' && path === '/mgmt/schedule') {
            return this.reply(res, 200, { schedules: h.list() });
        }
        // POST /mgmt/schedule — create. Body: full manage_schedule args blob.
        if (req.method === 'POST' && path === '/mgmt/schedule') {
            const body = await readJsonBody(req).catch((err: unknown) => {
                this.reply(res, 400, {
                    error: err instanceof Error ? err.message : String(err),
                });
                return null;
            });
            if (body === null) return;
            const result = h.create(body);
            return result.ok
                ? this.reply(res, 201, result)
                : this.reply(res, 400, result);
        }
        // /mgmt/schedule/:id — remove / disable / enable
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

/**
 * Constant-time bearer-token comparison. Returns true iff the Authorization
 * header exactly matches "Bearer <token>". We short-circuit on length
 * mismatch to avoid allocating a timingSafeEqual buffer when there's no
 * chance of a match — this does leak token length, but that's a fixed
 * property of the deployed server (not per-request), so it's not a new
 * signal for the attacker.
 */
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
