import type { Database as Db } from 'better-sqlite3';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls';
import { Readable } from 'node:stream';
import type { CredentialBroker } from '../broker';
import { mintLeafCert } from '../crypto/ca';
import { appendAudit } from '../store/audit';
import { loadOrCreateRootCA, type RootCA } from '../store/ca-store';
import { listRules, parseInjectInto, type RuleRow } from '../store/rules';
import { hostMatchesScope, TokenVerifyError, verifyToken, type VerifiedToken } from '../store/tokens';

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

interface CertCacheEntry {
    context: SecureContext;
    expiresAt: number;
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

function getDek(broker: CredentialBroker): Buffer {
    const dek = (broker as unknown as { dek: Buffer | undefined }).dek;
    if (!dek) throw new Error('broker has no DEK (sealed)');
    return dek;
}

function applyRule(headers: Record<string, string | string[] | undefined>, rule: RuleRow, broker: CredentialBroker, who: string): boolean {
    const injection = parseInjectInto(rule.injectInto);
    if (!injection) return false;
    if (injection.kind !== 'header') return false;
    const targetHeader = injection.name.toLowerCase();
    const currentVal = headers[targetHeader];
    if (typeof currentVal !== 'string') return false;
    if (!currentVal.includes(rule.placeholder)) return false;
    let real: string;
    try {
        real = broker.get(rule.secretName, { who });
    } catch {
        return false;
    }
    headers[targetHeader] = currentVal.split(rule.placeholder).join(real);
    return true;
}

export function startProxyServer(opts: ProxyServerOptions): Promise<ProxyServerHandle> {
    const dek = getDek(opts.broker);
    const rootCA: RootCA = loadOrCreateRootCA(opts.db, dek);
    const certCache = new Map<string, CertCacheEntry>();

    function getContextForHost(hostname: string): SecureContext {
        const now = Date.now();
        const cached = certCache.get(hostname);
        if (cached && cached.expiresAt > now) return cached.context;
        const { certPem, keyPem } = mintLeafCert(rootCA.certPem, rootCA.keyPem, hostname);
        const context = createSecureContext({ cert: certPem, key: keyPem });
        certCache.set(hostname, { context, expiresAt: now + 23 * 60 * 60 * 1000 });
        return context;
    }

    async function handleDecryptedRequest(
        token: VerifiedToken,
        targetHost: string,
        targetPort: number,
        agentSocket: TLSSocket,
        firstChunk: Buffer | undefined,
    ): Promise<void> {
        const buffered: Buffer[] = firstChunk ? [firstChunk] : [];
        const reader = new Promise<void>((resolve, reject) => {
            agentSocket.on('data', (chunk: Buffer) => {
                buffered.push(chunk);
                const joined = Buffer.concat(buffered);
                const headerEnd = joined.indexOf('\r\n\r\n');
                if (headerEnd >= 0) {
                    agentSocket.pause();
                    resolve();
                }
            });
            agentSocket.on('error', reject);
            agentSocket.on('close', () => resolve());
        });
        await reader;

        const joined = Buffer.concat(buffered);
        const headerEnd = joined.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
            agentSocket.destroy();
            return;
        }
        const headerText = joined.slice(0, headerEnd).toString('utf8');
        const bodyStart = joined.slice(headerEnd + 4);
        const lines = headerText.split('\r\n');
        const requestLine = lines[0] ?? '';
        const [method, path] = requestLine.split(' ');
        const headers: Record<string, string | string[] | undefined> = {};
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i]!;
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const name = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim();
            const existing = headers[name];
            if (existing === undefined) headers[name] = value;
            else if (Array.isArray(existing)) existing.push(value);
            else headers[name] = [existing, value];
        }

        const allRules = listRules(opts.db).filter((r) => hostMatches(targetHost, r.hostPattern));
        let appliedRules = 0;
        for (const rule of allRules) {
            if (applyRule(headers, rule, opts.broker, token.label)) appliedRules++;
        }

        appendAudit(opts.db, dek, {
            actorToken: token.label,
            action: 'proxy.forward',
            resource: `${method} https://${targetHost}${path}`,
            outcome: 'success',
            metadata: { rulesApplied: appliedRules, totalRulesMatched: allRules.length },
        });

        const bodyChunks: Buffer[] = bodyStart.length > 0 ? [bodyStart] : [];
        agentSocket.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
        agentSocket.resume();

        const upstreamReq = httpsRequest({
            host: targetHost,
            port: targetPort,
            method,
            path,
            headers: Object.fromEntries(
                Object.entries(headers).filter(([k]) => k !== 'proxy-authorization' && k !== 'proxy-connection'),
            ) as Record<string, string | string[]>,
        }, (upstreamRes) => {
            const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ''}\r\n`;
            agentSocket.write(statusLine);
            const HOP_BY_HOP = new Set([
                'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
                'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
            ]);
            for (const [k, v] of Object.entries(upstreamRes.headers)) {
                if (v === undefined) continue;
                if (HOP_BY_HOP.has(k.toLowerCase())) continue;
                if (Array.isArray(v)) for (const vv of v) agentSocket.write(`${k}: ${vv}\r\n`);
                else agentSocket.write(`${k}: ${v}\r\n`);
            }
            agentSocket.write('connection: close\r\n');
            agentSocket.write('\r\n');
            upstreamRes.on('data', (chunk: Buffer) => agentSocket.write(chunk));
            upstreamRes.on('end', () => agentSocket.end());
        });

        upstreamReq.on('error', (err) => {
            try {
                agentSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n`);
            } catch { /* */ }
            agentSocket.destroy();
            appendAudit(opts.db, dek, {
                actorToken: token.label,
                action: 'proxy.forward',
                resource: `${method} https://${targetHost}${path}`,
                outcome: 'error:upstream',
                metadata: { error: err.message },
            });
        });

        Readable.from(bodyChunks).pipe(upstreamReq);
        agentSocket.on('data', (c) => upstreamReq.write(c));
        agentSocket.on('end', () => upstreamReq.end());
    }

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
        let token: VerifiedToken;
        try {
            token = verifyToken(opts.db, raw);
        } catch (err) {
            const reason = err instanceof TokenVerifyError ? err.reason : 'invalid';
            appendAudit(opts.db, dek, {
                actorToken: 'unknown',
                action: 'proxy.connect',
                resource: `${target.host}:${target.port}`,
                outcome: `denied:token-${reason}`,
            });
            deny(clientSocket, 407, 'Proxy Authentication Required');
            return;
        }
        if (!hostMatchesScope(token.scope, target.host)) {
            appendAudit(opts.db, dek, {
                actorToken: token.label,
                action: 'proxy.connect',
                resource: `${target.host}:${target.port}`,
                outcome: 'denied:host-not-in-scope',
            });
            deny(clientSocket, 403, 'Forbidden');
            return;
        }

        appendAudit(opts.db, dek, {
            actorToken: token.label,
            action: 'proxy.connect',
            resource: `${target.host}:${target.port}`,
            outcome: 'success',
            metadata: { mode: 'mitm' },
        });

        clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');

        const secureContext = getContextForHost(target.host);
        const tlsSocket = new TLSSocket(clientSocket, {
            isServer: true,
            secureContext,
        });

        tlsSocket.on('secure', () => {
            handleDecryptedRequest(token, target.host, target.port, tlsSocket, head.length > 0 ? head : undefined).catch((err) => {
                tlsSocket.destroy();
                appendAudit(opts.db, dek, {
                    actorToken: token.label,
                    action: 'proxy.forward',
                    resource: `${target.host}:${target.port}`,
                    outcome: 'error:handler',
                    metadata: { error: err instanceof Error ? err.message : String(err) },
                });
            });
        });

        tlsSocket.on('error', () => {
            tlsSocket.destroy();
        });
        clientSocket.on('error', () => tlsSocket.destroy());
        clientSocket.on('close', () => tlsSocket.destroy());
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

function hostMatches(host: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern === host) return true;
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
    return false;
}
