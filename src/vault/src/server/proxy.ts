import type { Database as Db } from 'better-sqlite3';
import type { IncomingMessage, Server } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { createSecureContext, rootCertificates, TLSSocket, type SecureContext } from 'node:tls';
import type { CredentialBroker } from '../broker';
import { mintLeafCert } from '../crypto/ca';
import { appendAudit } from '../store/audit';
import { loadOrCreateRootCA, type RootCA } from '../store/ca-store';
import { listRules, parseInjectInto, type RuleRow } from '../store/rules';
import { hostMatchesScope, secretMatchesScope, TokenVerifyError, verifyToken, type VerifiedToken } from '../store/tokens';

const MAX_REQUEST_HEADER_BYTES = 64 * 1024;
const MAX_CERT_CACHE_ENTRIES = 256;
const UPSTREAM_TIMEOUT_MS = 60_000;
const HEADER_VALUE_RE = /^[\x20-\x7e\t]*$/;

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
    const bearer = auth.match(/^Bearer\s+(.+)$/i);
    if (bearer) return bearer[1]!.trim();
    const basic = auth.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    if (basic) {
        try {
            const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
            const colon = decoded.indexOf(':');
            const token = colon < 0 ? decoded : decoded.slice(0, colon);
            return token.length > 0 ? token : undefined;
        } catch {
            return undefined;
        }
    }
    return undefined;
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
    const body = `HTTP/1.1 ${code} ${reason}\r\nProxy-Authenticate: Bearer\r\nProxy-Authenticate: Basic realm="flopsy-vault"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
    socket.end(body, () => { try { socket.destroy(); } catch { /* */ } });
}

function getDek(broker: CredentialBroker): Buffer {
    const dek = (broker as unknown as { dek: Buffer | undefined }).dek;
    if (!dek) throw new Error('broker has no DEK (sealed)');
    return dek;
}

interface ApplyContext {
    readonly headers: Record<string, string | string[] | undefined>;
    urlPath: string;
}

function applyRule(ctx: ApplyContext, rule: RuleRow, broker: CredentialBroker, token: VerifiedToken): boolean {
    if (!secretMatchesScope(token.scope, rule.secretName)) return false;
    const injection = parseInjectInto(rule.injectInto);
    if (!injection) return false;

    const fetchReal = (): string | undefined => {
        try {
            return broker.get(rule.secretName, { who: token.label });
        } catch {
            return undefined;
        }
    };

    if (injection.kind === 'header') {
        const targetHeader = injection.name.toLowerCase();
        const currentVal = ctx.headers[targetHeader];
        if (typeof currentVal !== 'string') return false;
        if (!currentVal.includes(rule.placeholder)) return false;
        const real = fetchReal();
        if (real === undefined) return false;
        ctx.headers[targetHeader] = currentVal.split(rule.placeholder).join(real);
        return true;
    }
    if (injection.kind === 'any-header') {
        let any = false;
        let real: string | undefined;
        for (const [name, value] of Object.entries(ctx.headers)) {
            if (typeof value !== 'string') continue;
            if (!value.includes(rule.placeholder)) continue;
            if (real === undefined) {
                real = fetchReal();
                if (real === undefined) return false;
            }
            ctx.headers[name] = value.split(rule.placeholder).join(real);
            any = true;
        }
        return any;
    }
    if (injection.kind === 'query' || injection.kind === 'any-query') {
        const qIndex = ctx.urlPath.indexOf('?');
        if (qIndex < 0) return false;
        const pathPart = ctx.urlPath.slice(0, qIndex);
        const params = new URLSearchParams(ctx.urlPath.slice(qIndex + 1));
        let any = false;
        let real: string | undefined;
        const keysToCheck = injection.kind === 'query' ? [injection.name] : Array.from(params.keys());
        for (const key of keysToCheck) {
            const v = params.get(key);
            if (v === null || !v.includes(rule.placeholder)) continue;
            if (real === undefined) {
                real = fetchReal();
                if (real === undefined) return false;
            }
            params.set(key, v.split(rule.placeholder).join(real));
            any = true;
        }
        if (any) ctx.urlPath = pathPart + '?' + params.toString();
        return any;
    }
    return false;
}

function evictOldestCertCacheEntry(cache: Map<string, CertCacheEntry>): void {
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
}

export function startProxyServer(opts: ProxyServerOptions): Promise<ProxyServerHandle> {
    const dek = getDek(opts.broker);
    const rootCA: RootCA = loadOrCreateRootCA(opts.db, dek);
    const certCache = new Map<string, CertCacheEntry>();

    function getContextForHost(hostname: string): SecureContext {
        const now = Date.now();
        const cached = certCache.get(hostname);
        if (cached && cached.expiresAt > now) {
            certCache.delete(hostname);
            certCache.set(hostname, cached);
            return cached.context;
        }
        while (certCache.size >= MAX_CERT_CACHE_ENTRIES) evictOldestCertCacheEntry(certCache);
        const { certPem, keyPem } = mintLeafCert(rootCA.certPem, rootCA.keyPem, hostname);
        const context = createSecureContext({ cert: certPem, key: keyPem });
        certCache.set(hostname, { context, expiresAt: now + 23 * 60 * 60 * 1000 });
        return context;
    }

    const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

    async function handleDecryptedRequest(
        token: VerifiedToken,
        targetHost: string,
        targetPort: number,
        agentSocket: TLSSocket,
        firstChunk: Buffer | undefined,
    ): Promise<void> {
        let buffered: Buffer[] | null = firstChunk ? [firstChunk] : [];
        let totalBufferedBytes = firstChunk ? firstChunk.length : 0;
        let headersSeen = false;
        let onData: ((c: Buffer) => void) | null = null;
        let onError: ((e: Error) => void) | null = null;
        let onClose: (() => void) | null = null;
        try {
            await new Promise<void>((resolve, reject) => {
                onData = (chunk: Buffer) => {
                    if (!buffered) return;
                    totalBufferedBytes += chunk.length;
                    if (totalBufferedBytes > MAX_REQUEST_HEADER_BYTES) {
                        reject(new Error('request headers exceed max size'));
                        return;
                    }
                    buffered.push(chunk);
                    if (chunk.includes(0x0a)) {
                        const joined = Buffer.concat(buffered);
                        if (joined.indexOf('\r\n\r\n') >= 0) {
                            headersSeen = true;
                            agentSocket.pause();
                            resolve();
                        }
                    }
                };
                onError = (e: Error) => reject(e);
                onClose = () => {
                    if (!headersSeen) reject(new Error('socket closed before headers'));
                };
                agentSocket.on('data', onData);
                agentSocket.on('error', onError);
                agentSocket.once('close', onClose);
            });
        } catch (err) {
            if (onData) agentSocket.off('data', onData);
            if (onError) agentSocket.off('error', onError);
            if (onClose) agentSocket.off('close', onClose);
            buffered = null;
            try { agentSocket.destroy(); } catch { /* */ }
            appendAudit(opts.db, dek, {
                actorToken: token.label,
                action: 'proxy.forward',
                resource: `CONNECT ${targetHost}:${targetPort}`,
                outcome: 'error:bad-request',
                metadata: { reason: errorClass(err) },
            });
            return;
        }
        if (onData) agentSocket.off('data', onData);
        if (onError) agentSocket.off('error', onError);
        if (onClose) agentSocket.off('close', onClose);

        const joined = Buffer.concat(buffered);
        buffered = null;
        const headerEnd = joined.indexOf('\r\n\r\n');
        const headerText = joined.slice(0, headerEnd).toString('utf8');
        const bodyStart = joined.slice(headerEnd + 4);
        const lines = headerText.split('\r\n');
        const requestLine = lines[0] ?? '';
        const [method, path] = requestLine.split(' ');

        if (!method || !path || !ALLOWED_METHODS.has(method) || /[\r\n\x00]/.test(path)) {
            try { agentSocket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch { /* */ }
            return;
        }

        const headers: Record<string, string | string[] | undefined> = {};
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i]!;
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const name = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim();
            if (!HEADER_VALUE_RE.test(value)) {
                try { agentSocket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch { /* */ }
                return;
            }
            const existing = headers[name];
            if (existing === undefined) headers[name] = value;
            else if (Array.isArray(existing)) existing.push(value);
            else headers[name] = [existing, value];
        }

        if (Array.isArray(headers['content-length']) || (headers['content-length'] && headers['transfer-encoding'])) {
            try { agentSocket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch { /* */ }
            return;
        }

        const allRules = listRules(opts.db).filter((r) => hostMatches(targetHost, r.hostPattern));
        let appliedRules = 0;
        const applyCtx: ApplyContext = { headers, urlPath: path };
        for (const rule of allRules) {
            if (applyRule(applyCtx, rule, opts.broker, token)) appliedRules++;
        }
        const effectivePath = applyCtx.urlPath;

        appendAudit(opts.db, dek, {
            actorToken: token.label,
            action: 'proxy.forward',
            resource: `${method} https://${targetHost}${effectivePath.split('?')[0]}`,
            outcome: 'success',
            metadata: { rulesApplied: appliedRules, totalRulesMatched: allRules.length },
        });

        const hostHeaderValue = targetPort === 443 ? targetHost : `${targetHost}:${targetPort}`;
        const upstreamHeaders: Record<string, string | string[]> = Object.fromEntries(
            Object.entries(headers).filter(([k]) => k !== 'proxy-authorization' && k !== 'proxy-connection' && k !== 'host'),
        ) as Record<string, string | string[]>;
        upstreamHeaders['host'] = hostHeaderValue;
        upstreamHeaders['accept-encoding'] = 'identity';

        const upstreamReq = httpsRequest({
            host: targetHost,
            port: targetPort,
            method,
            path: effectivePath,
            headers: upstreamHeaders,
            rejectUnauthorized: true,
            servername: targetHost,
            minVersion: 'TLSv1.2',
            ca: [...rootCertificates],
        }, (upstreamRes) => {
            const HOP_BY_HOP = new Set([
                'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
                'te', 'trailer', 'transfer-encoding', 'upgrade',
            ]);
            agentSocket.cork();
            agentSocket.write(`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ''}\r\n`);
            for (const [k, v] of Object.entries(upstreamRes.headers)) {
                if (v === undefined) continue;
                if (HOP_BY_HOP.has(k.toLowerCase())) continue;
                if (Array.isArray(v)) for (const vv of v) agentSocket.write(`${k}: ${vv}\r\n`);
                else agentSocket.write(`${k}: ${v}\r\n`);
            }
            agentSocket.write('connection: close\r\n\r\n');
            agentSocket.uncork();
            upstreamRes.on('data', (chunk: Buffer) => {
                const ok = agentSocket.write(chunk);
                if (!ok) upstreamRes.pause();
            });
            agentSocket.on('drain', () => upstreamRes.resume());
            upstreamRes.on('end', () => agentSocket.end());
            upstreamRes.on('error', () => { try { agentSocket.destroy(); } catch { /* */ } });
        });

        upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
            try { upstreamReq.destroy(new Error('upstream timeout')); } catch { /* */ }
        });

        upstreamReq.on('error', (err) => {
            try { agentSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch { /* */ }
            appendAudit(opts.db, dek, {
                actorToken: token.label,
                action: 'proxy.forward',
                resource: `${method} https://${targetHost}${path}`,
                outcome: 'error:upstream',
                metadata: { reason: errorClass(err) },
            });
        });

        const declaredLen = parseInt(String(headers['content-length'] ?? '0'), 10) || 0;
        const hasChunked = String(headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
        if (bodyStart.length > 0) upstreamReq.write(bodyStart);

        if (!hasChunked && declaredLen <= bodyStart.length) {
            upstreamReq.end();
        } else {
            let received = bodyStart.length;
            const onBody = (c: Buffer) => {
                if (!upstreamReq.write(c)) agentSocket.pause();
                received += c.length;
                if (!hasChunked && declaredLen > 0 && received >= declaredLen) {
                    upstreamReq.end();
                    agentSocket.off('data', onBody);
                }
            };
            const onEnd = () => upstreamReq.end();
            agentSocket.on('data', onBody);
            agentSocket.once('end', onEnd);
            upstreamReq.on('drain', () => agentSocket.resume());
            agentSocket.once('close', () => {
                agentSocket.off('data', onBody);
                agentSocket.off('end', onEnd);
            });
        }
        agentSocket.resume();
    }

    function errorClass(err: unknown): string {
        const msg = err instanceof Error ? err.message : String(err);
        if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'dns_fail';
        if (/CERT|ALPN|TLS|SSL|handshake/i.test(msg)) return 'tls_fail';
        if (/ECONNRESET|ECONNREFUSED|EPIPE/.test(msg)) return 'net_reset';
        if (/timeout|ETIMEDOUT/.test(msg)) return 'timeout';
        if (/exceed max size/.test(msg)) return 'header_too_large';
        if (/closed before headers/.test(msg)) return 'client_aborted';
        return 'unknown';
    }

    const proxyLeaf = mintLeafCert(rootCA.certPem, rootCA.keyPem, opts.host);
    const server = createHttpsServer({
        cert: proxyLeaf.certPem,
        key: proxyLeaf.keyPem,
        ALPNProtocols: ['http/1.1'],
    }, (_req, res) => {
        res.statusCode = 405;
        res.setHeader('content-type', 'text/plain');
        res.end('vault proxy: use CONNECT for HTTPS upstreams\n');
    });

    const liveSockets = new Set<Socket>();
    server.on('secureConnection', (sock: TLSSocket) => {
        liveSockets.add(sock);
        sock.once('close', () => liveSockets.delete(sock));
    });

    const handleConnect = (req: IncomingMessage, clientSocket: Socket, head: Buffer): void => {
        liveSockets.add(clientSocket);
        clientSocket.once('close', () => liveSockets.delete(clientSocket));
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
            ALPNProtocols: ['http/1.1'],
        });
        liveSockets.add(tlsSocket);
        tlsSocket.once('close', () => liveSockets.delete(tlsSocket));

        tlsSocket.once('secure', () => {
            handleDecryptedRequest(token, target.host, target.port, tlsSocket, head.length > 0 ? head : undefined).catch((err) => {
                try { tlsSocket.destroy(); } catch { /* */ }
                appendAudit(opts.db, dek, {
                    actorToken: token.label,
                    action: 'proxy.forward',
                    resource: `${target.host}:${target.port}`,
                    outcome: 'error:handler',
                    metadata: { reason: errorClass(err) },
                });
            });
        });

        tlsSocket.once('error', () => { try { tlsSocket.destroy(); } catch { /* */ } });
        clientSocket.once('error', () => { try { tlsSocket.destroy(); } catch { /* */ } });
        clientSocket.once('close', () => { try { tlsSocket.destroy(); } catch { /* */ } });
    };

    server.on('connect', handleConnect);

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, () => {
            server.removeListener('error', reject);
            resolve({
                server,
                close: () => new Promise<void>((res) => {
                    server.close(() => res());
                    for (const s of liveSockets) {
                        try { s.destroy(); } catch { /* */ }
                    }
                    liveSockets.clear();
                }),
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
