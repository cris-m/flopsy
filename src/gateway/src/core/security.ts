import { timingSafeEqual, createHmac } from 'crypto';
import { resolve, sep } from 'path';

const SAFE_ID_REGEX = /^[a-zA-Z0-9._:+@-]+$/;

const MAX_MESSAGE_ID_LENGTH = 256;
const MAX_CHANNEL_NAME_LENGTH = 64;
const MAX_BODY_LENGTH = 50_000;

export interface RateLimitConfig {
    windowMs: number;
    maxRequests: number;
    maxConnectionsPerIp: number;
    blockDurationMs: number;
    maxTrackedClients: number;
}

export interface SanitizedMessage {
    id: string;
    channelName: string;
    body: string;
}

export interface WebhookSignatureConfig {
    algorithm: 'sha1' | 'sha256' | 'sha512';
    format: 'hex' | 'base64';
    prefix?: string;
}

const BLOCKED_HOSTS = new Set([
    'localhost', 
    '127.0.0.1', 
    '0.0.0.0', 
    '[::1]', 
    '::1',
    '169.254.169.254', 
    '169.254.170.2',
    '100.100.100.200',
    'metadata.google.internal', 
    'metadata.azure.internal',
    'kubernetes.default.svc',
]);

const PRIVATE_PATTERNS = [
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
    /^192\.0\.0\./,
    /^192\.0\.2\./,
    /^198\.18\./,
    /^198\.51\.100\./,
    /^203\.0\.113\./,
    /^224\./,
    /^240\./,
    /^0x/i,
    /^\d{8,}$/,
    /^0[0-7]+\./,
    /^\d+\.\d+$/,
    /^\d+\.\d+\.\d+$/,
    /^::1$/,
    /^\[::1\]$/,
    /^::$/,
    /^\[::\]$/,
    /^fc[0-9a-f]{2}:/i,
    /^fd[0-9a-f]{2}:/i,
    /^fe80:/i,
    /^::ffff:/i,
    /^\[::ffff:/i,
    /^\[(fc|fd|fe80)/i,
    /^localhost$/i,
    /\.localhost$/i,
    /\.local$/i,
    /\.internal$/i,
];

export function validateToken(
    expected: string,
    provided: string | null | undefined,
): boolean {
    if (!provided || !expected) return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export function extractToken(
    headers: Record<string, string | string[] | undefined>,
    url?: string,
): string | null {
    const auth = headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
        return auth.slice(7);
    }

    const protocol = headers['sec-websocket-protocol'];
    if (typeof protocol === 'string') {
        const match = protocol.match(/^auth\.(.+)$/);
        if (match?.[1]) return match[1];
    }

    if (url) {
        try {
            const parsed = new URL(url, 'http://localhost');
            return parsed.searchParams.get('token');
        } catch {
            return null;
        }
    }

    return null;
}

function normalizeIp(ip: string): string {
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return '127.0.0.1';
    return ip;
}

export function isLoopbackIp(ip: string): boolean {
    if (ip === 'localhost') return true;
    return normalizeIp(ip) === '127.0.0.1';
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
    windowMs: 60_000,
    maxRequests: 100,
    maxConnectionsPerIp: 5,
    blockDurationMs: 300_000,
    maxTrackedClients: 10_000,
};

interface ClientState {
    requests: number[];
    blockedUntil: number | null;
}

export class RateLimiter {
    private readonly config: RateLimitConfig;
    private readonly clients = new Map<string, ClientState>();
    private readonly connectionsByIp = new Map<string, Set<string>>();
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;

    constructor(config: Partial<RateLimitConfig> = {}) {
        this.config = { ...DEFAULT_RATE_LIMIT, ...config };
        this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
        this.cleanupInterval.unref();
    }

    checkRequest(clientId: string): { allowed: boolean; retryAfterMs?: number } {
        const now = Date.now();
        let state = this.clients.get(clientId);

        if (!state) {
            state = { requests: [], blockedUntil: null };
            this.clients.set(clientId, state);
            this.enforceClientLimit();
        }

        if (state.blockedUntil && now < state.blockedUntil) {
            return { allowed: false, retryAfterMs: state.blockedUntil - now };
        }

        if (state.blockedUntil) {
            state.blockedUntil = null;
            state.requests = [];
        }

        const windowStart = now - this.config.windowMs;
        state.requests = state.requests.filter((ts) => ts > windowStart);

        if (state.requests.length >= this.config.maxRequests) {
            state.blockedUntil = now + this.config.blockDurationMs;
            return { allowed: false, retryAfterMs: this.config.blockDurationMs };
        }

        state.requests.push(now);
        return { allowed: true };
    }

    checkConnection(clientIp: string): boolean {
        const conns = this.connectionsByIp.get(clientIp);
        if (!conns) return true;
        return conns.size < this.config.maxConnectionsPerIp;
    }

    registerConnection(clientId: string, clientIp: string): void {
        let conns = this.connectionsByIp.get(clientIp);
        if (!conns) {
            conns = new Set();
            this.connectionsByIp.set(clientIp, conns);
        }
        conns.add(clientId);
    }

    unregisterConnection(clientId: string, clientIp: string): void {
        const conns = this.connectionsByIp.get(clientIp);
        if (conns) {
            conns.delete(clientId);
            if (conns.size === 0) this.connectionsByIp.delete(clientIp);
        }
        this.clients.delete(clientId);
    }

    stop(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.clients.clear();
        this.connectionsByIp.clear();
    }

    private enforceClientLimit(): void {
        if (this.clients.size <= this.config.maxTrackedClients) return;
        const excess = this.clients.size - this.config.maxTrackedClients;
        const iter = this.clients.keys();
        for (let i = 0; i < excess; i++) {
            const key = iter.next().value;
            if (key) this.clients.delete(key);
        }
    }

    private cleanup(): void {
        const now = Date.now();
        const windowStart = now - this.config.windowMs;
        for (const [id, state] of this.clients) {
            state.requests = state.requests.filter((ts) => ts > windowStart);
            if (state.requests.length === 0 && !state.blockedUntil) {
                this.clients.delete(id);
            } else if (state.blockedUntil && now >= state.blockedUntil && state.requests.length === 0) {
                this.clients.delete(id);
            }
        }
    }
}

export function sanitize(input: string, maxLength: number): string {
    return input.replace(/\0/g, '').trim().slice(0, maxLength);
}

export function isSafeIdentifier(id: string, maxLength = 128): boolean {
    return id.length > 0 && id.length <= maxLength && SAFE_ID_REGEX.test(id);
}

export function resolveSafePath(basePath: string, userPath: string): string {
    const cleaned = userPath.replace(/\0/g, '');
    const resolved = resolve(basePath, cleaned);
    const normalizedBase = resolve(basePath) + sep;

    if (!resolved.startsWith(normalizedBase) && resolved !== resolve(basePath)) {
        throw new Error(`Path traversal detected: "${userPath}" escapes base directory`);
    }
    return resolved;
}

export function verifyWebhookSignature(
    secret: string,
    body: string,
    signature: string,
    config: WebhookSignatureConfig = { algorithm: 'sha256', format: 'hex' },
): boolean {
    if (!secret || !signature) return false;

    let provided = signature;
    if (config.prefix && provided.startsWith(config.prefix)) {
        provided = provided.slice(config.prefix.length);
    }

    const expected = createHmac(config.algorithm, secret)
        .update(body)
        .digest(config.format);

    try {
        return timingSafeEqual(
            Buffer.from(provided, config.format === 'base64' ? 'base64' : 'hex'),
            Buffer.from(expected, config.format === 'base64' ? 'base64' : 'hex'),
        );
    } catch {
        return false;
    }
}

export function isSafeMediaUrl(url?: string): boolean {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
        const host = parsed.hostname.replace(/^\[|\]$/g, '');
        if (BLOCKED_HOSTS.has(host)) return false;
        for (const pattern of PRIVATE_PATTERNS) {
            if (pattern.test(host)) return false;
        }
        return true;
    } catch {
        return false;
    }
}

export function sanitizeInbound(msg: {
    id: string;
    channelName: string;
    body: string;
    peer?: { id: string; type: 'user' | 'group' | 'channel'; name?: string };
    sender?: { id: string; name?: string };
}): SanitizedMessage & {
    peer?: { id: string; type: 'user' | 'group' | 'channel'; name?: string };
    sender?: { id: string; name?: string };
} {
    const result: SanitizedMessage & {
        peer?: { id: string; type: 'user' | 'group' | 'channel'; name?: string };
        sender?: { id: string; name?: string };
    } = {
        id: msg.id.replace(/\0/g, '').slice(0, MAX_MESSAGE_ID_LENGTH),
        channelName: msg.channelName.replace(/\0/g, '').slice(0, MAX_CHANNEL_NAME_LENGTH),
        body: msg.body.replace(/\0/g, '').trim().slice(0, MAX_BODY_LENGTH),
    };
    if (msg.peer) {
        result.peer = {
            id: msg.peer.id.replace(/\0/g, '').slice(0, MAX_MESSAGE_ID_LENGTH),
            type: msg.peer.type,
            ...(msg.peer.name && { name: sanitize(msg.peer.name, 200) }),
        };
    }
    if (msg.sender) {
        result.sender = {
            id: msg.sender.id.replace(/\0/g, '').slice(0, MAX_MESSAGE_ID_LENGTH),
            ...(msg.sender.name && { name: sanitize(msg.sender.name, 200) }),
        };
    }
    return result;
}
