/**
 * Read-only management HTTP server bound to 127.0.0.1 only. Auth via
 * `GATEWAY_TOKEN` env or <FLOPSY_HOME>/gateway-token file
 * (auto-generated on first gateway boot). Unauthenticated requests get 401.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '@flopsy/shared';
import { sanitizeErrorHint } from '@gateway/core/security';
import type { ChatHandler } from './chat-handler';

const log = createLogger('management-server');

const MAX_WINDOW_MS = 30 * 86_400_000;

function safeErrorBody(err: unknown): { error: string } {
    const raw = err instanceof Error ? err.message : String(err);
    return { error: sanitizeErrorHint(raw) ?? 'internal-error' };
}

/** Fire a synthetic event so an operator can verify a hook works without
 *  waiting for the natural event to occur. */
export interface HooksMgmtHandlers {
    test(event: string, payload: Record<string, unknown>): { ok: boolean; matched: number; message?: string };
}

/** Unset → schedule routes return 501. */
export interface ScheduleMgmtHandlers {
    create(
        body: unknown,
    ): Promise<{ ok: true; id: string; message: string } | { ok: false; error: string }>;
    remove(id: string): { ok: boolean; message?: string };
    setEnabled(id: string, enabled: boolean): { ok: boolean; message?: string };
    /** REPLACE semantics — caller provides the full new array. */
    setSkills(id: string, skills: string[]): { ok: boolean; message?: string };
    list(): Array<Record<string, unknown>>;
    trigger(id: string): Promise<{ ok: boolean; message?: string }>;
    /** Fire every enabled schedule of a kind right now. Returns the dispatched ids. */
    tick(kind: 'cron' | 'heartbeat'): { ok: boolean; dispatched: string[] };
}

export interface ManagementServerOptions {
    readonly host?: string;
    readonly port: number;
    readonly token?: string;
    readonly snapshotFn: () => unknown;
    readonly pingFn?: () => Record<string, unknown>;
    readonly scheduleHandlers?: ScheduleMgmtHandlers;
    readonly hooksHandlers?: HooksMgmtHandlers;
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
    readonly harnessActivityFn?: (windowMs: number) => unknown;
    /**
     * Drops the cached skill catalog in every running agent's `skills()`
     * interceptor so the next turn re-scans `.flopsy/content/skills/`. Use
     * after `flopsy skill install`, `proposed promote`, or `uninstall` to
     * avoid a gateway restart.
     */
    readonly skillReloadFn?: () => { reloaded: boolean };
    /**
     * One-shot stateless agent invocation used by the skill-eval framework.
     * Builds a fresh agent (fresh `skills()` interceptor → fresh catalog scan),
     * runs the prompt, returns the agent's reply text and timing.
     */
    readonly evalRunFn?: (req: {
        prompt: string;
        timeoutMs?: number;
    }) => Promise<{
        reply: string;
        durationMs: number;
        tokenUsage?: { input: number; output: number };
        error?: string;
    }>;
    readonly chatHandler?: ChatHandler;
}

export class ManagementServer {
    private server: Server | null = null;
    private readonly opts: ManagementServerOptions;
    private startedAt = Date.now();

    constructor(opts: ManagementServerOptions) {
        this.opts = opts;
    }

    async start(): Promise<void> {
        const { host = '127.0.0.1', port } = this.opts;
        this.startedAt = Date.now();
        this.server = createServer((req, res) => {
            this.onRequest(req, res).catch((err) => {
                log.error({ err }, 'management request handler threw');
                if (!res.headersSent) {
                    this.reply(res, 500, {
                        ...safeErrorBody(err),
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
        if (this.opts.token) {
            log.info({ host, port, auth: 'bearer', chat: !!this.opts.chatHandler }, 'management server listening');
        } else {
            log.warn({ host, port, chat: !!this.opts.chatHandler }, 'management server listening WITHOUT auth — set GATEWAY_TOKEN in production');
        }
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        this.server = null;
    }

    private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        // Bearer token check — when GATEWAY_TOKEN is set, require it
        // on every non-ping request. Ping stays open so `flopsy management
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

        // `/ping` is the one unauthenticated route — used by `flopsy doctor`
        // and similar liveness probes that shouldn't need to ship a token.
        // Everything else (including read-only `/status` and `/snapshot`)
        // requires a valid bearer. The token is auto-generated by
        // resolveOrCreateMgmtToken() at startup so this is never "fails open".
        if (path !== '/management/ping') {
            if (!this.opts.token) {
                // Defensive: opts.token should always be set now, but a
                // future caller may pass undefined explicitly. Treat that
                // as misconfiguration, not as "open API".
                return this.reply(res, 503, { error: 'mgmt token not configured' });
            }
            const auth = req.headers['authorization'] ?? '';
            if (!isValidBearer(auth, this.opts.token)) {
                return this.reply(res, 401, { error: 'unauthorized' });
            }
        }

        if (req.method === 'GET' && path === '/management/ping') {
            return this.reply(
                res,
                200,
                this.opts.pingFn
                    ? this.opts.pingFn()
                    : { ok: true, uptimeMs: Date.now() - this.startedAt },
            );
        }

        if (req.method === 'GET' && path === '/management/status') {
            try {
                return this.reply(res, 200, this.opts.snapshotFn());
            } catch (err) {
                return this.reply(res, 500, {
                    ...safeErrorBody(err),
                });
            }
        }

        const dnd = this.opts.dndHandlers;
        if (dnd && path.startsWith('/management/dnd')) {
            try {
                if (req.method === 'GET' && path === '/management/dnd') {
                    return this.reply(res, 200, await dnd.status());
                }
                if (req.method === 'POST' && path === '/management/dnd/on') {
                    const body = (await readJsonBody(req)) as {
                        durationMs?: number;
                        reason?: string;
                    };
                    if (typeof body.durationMs !== 'number' || body.durationMs <= 0) {
                        return this.reply(res, 400, { error: 'durationMs > 0 required' });
                    }
                    return this.reply(res, 200, await dnd.setDnd(body as { durationMs: number; reason?: string }));
                }
                if (req.method === 'POST' && path === '/management/dnd/off') {
                    await dnd.clearDnd();
                    return this.reply(res, 200, { ok: true, message: 'DND cleared' });
                }
                if (req.method === 'POST' && path === '/management/dnd/quiet') {
                    const body = (await readJsonBody(req)) as { untilMs?: number };
                    if (typeof body.untilMs !== 'number' || body.untilMs <= Date.now()) {
                        return this.reply(res, 400, { error: 'untilMs must be a future epoch-ms' });
                    }
                    return this.reply(res, 200, await dnd.setQuietHours(body as { untilMs: number }));
                }
            } catch (err) {
                return this.reply(res, 500, {
                    ...safeErrorBody(err),
                });
            }
            return this.reply(res, 405, { error: 'method not allowed', path });
        }

        const proactive = this.opts.proactiveStatsHandlers;
        if (proactive && path.startsWith('/management/proactive')) {
            if (req.method === 'GET' && path === '/management/proactive/stats') {
                const windowMs = Number(query.get('windowMs') ?? 86_400_000);
                if (!Number.isFinite(windowMs) || windowMs <= 0 || windowMs > MAX_WINDOW_MS) {
                    return this.reply(res, 400, { error: 'windowMs out of range' });
                }
                return this.reply(res, 200, await proactive.getStats(windowMs));
            }
            const firesMatch = path.match(/^\/management\/proactive\/fires\/([^/]+)$/);
            if (req.method === 'GET' && firesMatch) {
                const id = decodeURIComponent(firesMatch[1]!);
                const limit = Number(query.get('limit') ?? 20);
                return this.reply(res, 200, { fires: proactive.getFires(id, limit) });
            }
            return this.reply(res, 404, { error: 'not found', path });
        }

        if (req.method === 'POST' && path === '/management/skills/reload') {
            if (!this.opts.skillReloadFn) {
                return this.reply(res, 501, { error: 'skill reload endpoint not wired' });
            }
            return this.reply(res, 200, this.opts.skillReloadFn());
        }

        if (req.method === 'POST' && path === '/management/skill-eval-run') {
            if (!this.opts.evalRunFn) {
                return this.reply(res, 501, { error: 'skill-eval-run endpoint not wired' });
            }
            const body = await readJsonBody(req).catch((err: unknown) => {
                this.reply(res, 400, { ...safeErrorBody(err) });
                return null;
            });
            if (body === null) return;
            const { prompt, timeoutMs } = body as { prompt?: unknown; timeoutMs?: unknown };
            if (typeof prompt !== 'string' || prompt.length === 0) {
                return this.reply(res, 400, { error: 'body must include `prompt` (non-empty string)' });
            }
            const tm = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : undefined;
            try {
                const out = await this.opts.evalRunFn({ prompt, ...(tm !== undefined ? { timeoutMs: tm } : {}) });
                return this.reply(res, 200, out);
            } catch (err) {
                return this.reply(res, 500, { ...safeErrorBody(err) });
            }
        }

        if (req.method === 'GET' && path === '/management/harness/activity') {
            if (!this.opts.harnessActivityFn) {
                return this.reply(res, 501, { error: 'harness activity endpoint not wired' });
            }
            const windowMs = Number(query.get('windowMs') ?? 86_400_000);
            if (!Number.isFinite(windowMs) || windowMs <= 0 || windowMs > MAX_WINDOW_MS) {
                return this.reply(res, 400, { error: 'windowMs out of range' });
            }
            return this.reply(res, 200, this.opts.harnessActivityFn(windowMs));
        }

        if (req.method === 'GET' && path === '/management/tasks') {
            if (!this.opts.tasksFn) {
                return this.reply(res, 501, { error: 'tasks endpoint not wired' });
            }
            try {
                return this.reply(res, 200, this.opts.tasksFn(query));
            } catch (err) {
                return this.reply(res, 500, {
                    ...safeErrorBody(err),
                });
            }
        }

        const handlers = this.opts.scheduleHandlers;
        // POST /management/hooks/test — synthetic event firing for the
        if (req.method === 'POST' && path === '/management/hooks/test') {
            const handlers = this.opts.hooksHandlers;
            if (!handlers) {
                return this.reply(res, 501, { error: 'hooks handlers not wired' });
            }
            const body = await readJsonBody(req).catch((err: unknown) => {
                this.reply(res, 400, { ...safeErrorBody(err) });
                return null;
            });
            if (body === null) return;
            const { event, payload } = (body as { event?: string; payload?: Record<string, unknown> });
            if (!event || typeof event !== 'string') {
                return this.reply(res, 400, { error: 'body must include `event` (string)' });
            }
            const result = handlers.test(event, payload ?? {});
            return this.reply(res, 200, result);
        }
        if (path === '/management/schedule' || path.startsWith('/management/schedule/')) {
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
        if (req.method === 'GET' && path === '/management/schedule') {
            return this.reply(res, 200, { schedules: h.list() });
        }
        if (req.method === 'POST' && path === '/management/schedule') {
            const body = await readJsonBody(req).catch((err: unknown) => {
                this.reply(res, 400, {
                    ...safeErrorBody(err),
                });
                return null;
            });
            if (body === null) return;
            const result = await h.create(body);
            return result.ok
                ? this.reply(res, 201, result)
                : this.reply(res, 400, result);
        }
        // `/tick` is a kind-scoped admin: trigger every enabled schedule of
        // the given kind. Lives at a sibling path (not /schedule/<id>/...)
        // because there's no id involved. The kind is read from the query
        // string (re-parsed here because the outer handler doesn't pass
        // its parsed URL down — keeps this route self-contained).
        if (req.method === 'POST' && path === '/management/schedule/tick') {
            const search = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            const kind = new URLSearchParams(search).get('kind');
            if (kind !== 'cron' && kind !== 'heartbeat') {
                return this.reply(res, 400, { error: 'kind must be "cron" or "heartbeat"' });
            }
            const result = h.tick(kind);
            return this.reply(res, 200, result);
        }
        const match = path.match(/^\/management\/schedule\/([^/]+)(?:\/(disable|enable|trigger|skills))?$/);
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
            if (req.method === 'POST' && action === 'trigger') {
                const result = await h.trigger(id);
                return result.ok
                    ? this.reply(res, 200, result)
                    : this.reply(res, 404, result);
            }
            if (req.method === 'POST' && action === 'skills') {
                // Body: `{ skills: ["foo", "bar"] }` — REPLACE semantics.
                // Client decides add/remove/clear; we just take the new list.
                const body = await readJsonBody(req).catch((err: unknown) => {
                    this.reply(res, 400, {
                        ...safeErrorBody(err),
                    });
                    return null;
                });
                if (body === null) return;
                const raw = (body as { skills?: unknown }).skills;
                if (!Array.isArray(raw)) {
                    return this.reply(res, 400, {
                        error: 'body must be { skills: string[] }',
                    });
                }
                const cleaned = raw
                    .filter((v): v is string => typeof v === 'string')
                    .map((v) => v.trim())
                    .filter((v) => v.length > 0);
                const result = h.setSkills(id, cleaned);
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
