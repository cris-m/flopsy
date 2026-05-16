import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { CredentialBroker } from '../broker';
import { appendAudit } from '../store/audit';
import { hostMatchesScope, TokenVerifyError, verifyToken } from '../store/tokens';
import type { Database as Db } from 'better-sqlite3';

export interface ProxyServerOptions {
    host: string;
    port: number;
    db: Db;
    broker: CredentialBroker;
}

export interface ProxyServerHandle {
    server: Server;
    close: () => Promise<void>;
    address: () => string;
}

function readBearer(req: IncomingMessage): string | undefined {
    const auth = req.headers['proxy-authorization'];
    if (typeof auth !== 'string') return undefined;
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return m ? m[1]!.trim() : undefined;
}

function parseConnectTarget(rawUrl: string | undefined): { host: string; port: number } | undefined {
    if (!rawUrl) return undefined;
    const parts = rawUrl.split(':');
    if (parts.length !== 2) return undefined;
    const host = parts[0]!.trim();
    const port = parseInt(parts[1]!, 10);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { host, port };
}

function deny(socket: Socket, code: number, reason: string): void {
    try {
        socket.write(`HTTP/1.1 ${code} ${reason}\r\nProxy-Authenticate: Bearer\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    } finally {
        socket.destroy();
    }
}

export function startProxyServer(opts: ProxyServerOptions): Promise<ProxyServerHandle> {
    const server = createServer((req, res) => {
        res.statusCode = 405;
        res.setHeader('content-type', 'text/plain');
        res.end('vault proxy: use CONNECT for HTTPS upstreams\n');
    });

    server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
        const target = parseConnectTarget(req.url);
        if (!target) {
            deny(clientSocket, 400, 'Bad Request');
            return;
        }
        const raw = readBearer(req);
        if (!raw) {
            deny(clientSocket, 407, 'Proxy Authentication Required');
            return;
        }
        let token;
        try {
            token = verifyToken(opts.db, raw);
        } catch (err) {
            const reason = err instanceof TokenVerifyError ? err.reason : 'invalid';
            appendAudit(opts.db, getDek(opts.broker), {
                actorToken: 'unknown',
                action: 'proxy.connect',
                resource: `${target.host}:${target.port}`,
                outcome: `denied:token-${reason}`,
            });
            deny(clientSocket, 407, 'Proxy Authentication Required');
            return;
        }
        if (!hostMatchesScope(token.scope, target.host)) {
            appendAudit(opts.db, getDek(opts.broker), {
                actorToken: token.label,
                action: 'proxy.connect',
                resource: `${target.host}:${target.port}`,
                outcome: 'denied:host-not-in-scope',
            });
            deny(clientSocket, 403, 'Forbidden');
            return;
        }

        const upstream = netConnect(target.port, target.host, () => {
            appendAudit(opts.db, getDek(opts.broker), {
                actorToken: token.label,
                action: 'proxy.connect',
                resource: `${target.host}:${target.port}`,
                outcome: 'success',
                metadata: { mode: 'passthrough' },
            });
            clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
            if (head.length > 0) upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });

        upstream.on('error', (err) => {
            try {
                clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
            } catch {
                /* */
            }
            clientSocket.destroy();
            appendAudit(opts.db, getDek(opts.broker), {
                actorToken: token.label,
                action: 'proxy.connect',
                resource: `${target.host}:${target.port}`,
                outcome: 'error:upstream',
                metadata: { error: err.message },
            });
        });

        clientSocket.on('error', () => {
            upstream.destroy();
        });

        clientSocket.on('close', () => {
            upstream.destroy();
        });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, () => {
            server.removeListener('error', reject);
            resolve({
                server,
                close: () => new Promise<void>((res) => server.close(() => res())),
                address: () => `${opts.host}:${opts.port}`,
            });
        });
    });
}

function getDek(broker: CredentialBroker): Buffer {
    const dek = (broker as unknown as { dek: Buffer | undefined }).dek;
    if (!dek) throw new Error('broker has no DEK (sealed)');
    return dek;
}
