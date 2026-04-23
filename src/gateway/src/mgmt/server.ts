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
import { createLogger } from '@flopsy/shared';

const log = createLogger('mgmt-server');

export interface MgmtServerOptions {
    readonly host?: string;
    readonly port: number;
    readonly token?: string;
    /** Called on GET /mgmt/status. Returns a JSON-serializable value. */
    readonly snapshotFn: () => unknown;
    /** Called on GET /mgmt/ping; defaults to process uptime. */
    readonly pingFn?: () => Record<string, unknown>;
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
        this.server = createServer((req, res) => this.onRequest(req, res));
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

    private onRequest(req: IncomingMessage, res: ServerResponse): void {
        // Bearer token check — when FLOPSY_MGMT_TOKEN is set, require it
        // on every non-ping request. Ping stays open so `flopsy mgmt
        // ping` works before the user sets a token.
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const path = url.pathname;

        if (this.opts.token && path !== '/mgmt/ping') {
            const auth = req.headers['authorization'];
            if (auth !== `Bearer ${this.opts.token}`) {
                return this.reply(res, 401, { error: 'unauthorized' });
            }
        }

        if (req.method === 'GET' && path === '/mgmt/ping') {
            return this.reply(
                res,
                200,
                this.opts.pingFn
                    ? this.opts.pingFn()
                    : {
                          ok: true,
                          uptimeMs: Date.now() - this.startedAt,
                      },
            );
        }

        if (req.method === 'GET' && path === '/mgmt/status') {
            try {
                const snap = this.opts.snapshotFn();
                return this.reply(res, 200, snap);
            } catch (err) {
                return this.reply(res, 500, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        this.reply(res, 404, { error: 'not found', path });
    }

    private reply(res: ServerResponse, status: number, body: unknown): void {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
    }
}
