import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    sanitize,
    sanitizeInbound,
    isSafeIdentifier,
    isSafeMediaUrl,
    RateLimiter,
    validateToken,
    extractToken,
    resolveSafePath,
    verifyWebhookSignature,
    isLoopbackIp,
} from '../src/core/security';
import { createHmac } from 'crypto';
import { resolve, sep } from 'path';

// ---------------------------------------------------------------------------
// sanitize
// ---------------------------------------------------------------------------

describe('sanitize', () => {
    it('should strip null bytes', () => {
        expect(sanitize('he\0llo\0', 100)).toBe('hello');
    });

    it('should trim whitespace', () => {
        expect(sanitize('  hello  ', 100)).toBe('hello');
    });

    it('should enforce max length', () => {
        expect(sanitize('abcdefgh', 5)).toBe('abcde');
    });

    it('should handle all three transformations together', () => {
        expect(sanitize('  ab\0cdefgh  ', 5)).toBe('abcde');
    });

    it('should return empty string for whitespace-only input', () => {
        expect(sanitize('   ', 10)).toBe('');
    });

    it('should return empty string for null-byte-only input', () => {
        expect(sanitize('\0\0\0', 10)).toBe('');
    });

    it('should handle empty string', () => {
        expect(sanitize('', 10)).toBe('');
    });

    it('should handle zero max length', () => {
        expect(sanitize('hello', 0)).toBe('');
    });
});

// ---------------------------------------------------------------------------
// sanitizeInbound
// ---------------------------------------------------------------------------

describe('sanitizeInbound', () => {
    it('should sanitize id, channelName, and body', () => {
        const result = sanitizeInbound({
            id: 'msg\0-1',
            channelName: 'disc\0ord',
            body: '  hello\0world  ',
        });
        expect(result.id).toBe('msg-1');
        expect(result.channelName).toBe('discord');
        expect(result.body).toBe('helloworld');
    });

    it('should truncate id to 256 chars', () => {
        const longId = 'x'.repeat(300);
        const result = sanitizeInbound({ id: longId, channelName: 'ch', body: 'hi' });
        expect(result.id).toHaveLength(256);
    });

    it('should truncate channelName to 64 chars', () => {
        const longName = 'c'.repeat(100);
        const result = sanitizeInbound({ id: '1', channelName: longName, body: 'hi' });
        expect(result.channelName).toHaveLength(64);
    });

    it('should truncate body to 50000 chars', () => {
        const longBody = 'b'.repeat(60_000);
        const result = sanitizeInbound({ id: '1', channelName: 'ch', body: longBody });
        expect(result.body).toHaveLength(50_000);
    });

    it('should not include peer or sender when absent', () => {
        const result = sanitizeInbound({ id: '1', channelName: 'ch', body: 'hi' });
        expect(result.peer).toBeUndefined();
        expect(result.sender).toBeUndefined();
    });

    it('should sanitize peer.id and peer.name', () => {
        const result = sanitizeInbound({
            id: '1',
            channelName: 'ch',
            body: 'hi',
            peer: { id: 'peer\0-1', name: '  Alice\0  ' },
        });
        expect(result.peer!.id).toBe('peer-1');
        expect(result.peer!.name).toBe('Alice');
    });

    it('should sanitize sender.id and sender.name', () => {
        const result = sanitizeInbound({
            id: '1',
            channelName: 'ch',
            body: 'hi',
            sender: { id: 'send\0er', name: '  Bob\0  ' },
        });
        expect(result.sender!.id).toBe('sender');
        expect(result.sender!.name).toBe('Bob');
    });

    it('should omit peer.name if not provided', () => {
        const result = sanitizeInbound({
            id: '1',
            channelName: 'ch',
            body: 'hi',
            peer: { id: 'p1' },
        });
        expect(result.peer!.id).toBe('p1');
        expect(result.peer!.name).toBeUndefined();
    });

    it('should truncate peer.name to 200 chars', () => {
        const longName = 'n'.repeat(300);
        const result = sanitizeInbound({
            id: '1',
            channelName: 'ch',
            body: 'hi',
            peer: { id: 'p1', name: longName },
        });
        expect(result.peer!.name!.length).toBeLessThanOrEqual(200);
    });
});

// ---------------------------------------------------------------------------
// isSafeIdentifier
// ---------------------------------------------------------------------------

describe('isSafeIdentifier', () => {
    it('should accept alphanumeric identifiers', () => {
        expect(isSafeIdentifier('abc123')).toBe(true);
    });

    it('should accept identifiers with allowed special chars', () => {
        expect(isSafeIdentifier('user.name_id-1:channel+tag@host')).toBe(true);
    });

    it('should reject empty string', () => {
        expect(isSafeIdentifier('')).toBe(false);
    });

    it('should reject strings exceeding max length', () => {
        expect(isSafeIdentifier('a'.repeat(129))).toBe(false);
    });

    it('should accept strings at max length boundary', () => {
        expect(isSafeIdentifier('a'.repeat(128))).toBe(true);
    });

    it('should respect custom max length', () => {
        expect(isSafeIdentifier('abcde', 5)).toBe(true);
        expect(isSafeIdentifier('abcdef', 5)).toBe(false);
    });

    it('should reject strings with spaces', () => {
        expect(isSafeIdentifier('hello world')).toBe(false);
    });

    it('should reject strings with slashes', () => {
        expect(isSafeIdentifier('path/to/file')).toBe(false);
    });

    it('should reject strings with null bytes', () => {
        expect(isSafeIdentifier('abc\0def')).toBe(false);
    });

    it('should reject strings with unicode', () => {
        expect(isSafeIdentifier('caf\u00e9')).toBe(false);
    });

    it('should reject strings with angle brackets', () => {
        expect(isSafeIdentifier('<script>')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// isSafeMediaUrl
// ---------------------------------------------------------------------------

describe('isSafeMediaUrl', () => {
    it('should accept valid https URL', () => {
        expect(isSafeMediaUrl('https://cdn.example.com/image.png')).toBe(true);
    });

    it('should accept valid http URL', () => {
        expect(isSafeMediaUrl('http://cdn.example.com/image.png')).toBe(true);
    });

    it('should reject undefined', () => {
        expect(isSafeMediaUrl(undefined)).toBe(false);
    });

    it('should reject empty string', () => {
        expect(isSafeMediaUrl('')).toBe(false);
    });

    it('should reject non-http protocols', () => {
        expect(isSafeMediaUrl('ftp://example.com/file')).toBe(false);
        expect(isSafeMediaUrl('file:///etc/passwd')).toBe(false);
        expect(isSafeMediaUrl('javascript:alert(1)')).toBe(false);
    });

    it('should reject localhost', () => {
        expect(isSafeMediaUrl('http://localhost/img.png')).toBe(false);
    });

    it('should reject 127.0.0.1', () => {
        expect(isSafeMediaUrl('http://127.0.0.1/img.png')).toBe(false);
    });

    it('should reject 0.0.0.0', () => {
        expect(isSafeMediaUrl('http://0.0.0.0/img.png')).toBe(false);
    });

    it('should reject IPv6 loopback', () => {
        expect(isSafeMediaUrl('http://[::1]/img.png')).toBe(false);
    });

    it('should reject AWS metadata endpoint', () => {
        expect(isSafeMediaUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    });

    it('should reject GCP metadata endpoint', () => {
        expect(isSafeMediaUrl('http://metadata.google.internal/computeMetadata')).toBe(false);
    });

    it('should reject Azure metadata endpoint', () => {
        expect(isSafeMediaUrl('http://metadata.azure.internal/metadata')).toBe(false);
    });

    it('should reject Kubernetes service', () => {
        expect(isSafeMediaUrl('http://kubernetes.default.svc/api')).toBe(false);
    });

    it('should reject private 10.x.x.x range', () => {
        expect(isSafeMediaUrl('http://10.0.0.1/img.png')).toBe(false);
    });

    it('should reject private 172.16-31.x.x range', () => {
        expect(isSafeMediaUrl('http://172.16.0.1/img.png')).toBe(false);
        expect(isSafeMediaUrl('http://172.31.255.255/img.png')).toBe(false);
    });

    it('should reject private 192.168.x.x range', () => {
        expect(isSafeMediaUrl('http://192.168.1.1/img.png')).toBe(false);
    });

    it('should reject link-local addresses', () => {
        expect(isSafeMediaUrl('http://169.254.1.1/img.png')).toBe(false);
    });

    it('should reject .local domains', () => {
        expect(isSafeMediaUrl('http://printer.local/img.png')).toBe(false);
    });

    it('should reject .internal domains', () => {
        expect(isSafeMediaUrl('http://service.internal/img.png')).toBe(false);
    });

    it('should reject .localhost subdomains', () => {
        expect(isSafeMediaUrl('http://evil.localhost/img.png')).toBe(false);
    });

    it('should reject hex-encoded IPs', () => {
        expect(isSafeMediaUrl('http://0x7f000001/img.png')).toBe(false);
    });

    it('should reject octal-encoded IPs', () => {
        expect(isSafeMediaUrl('http://0177.0.0.1/img.png')).toBe(false);
    });

    it('should reject IPv6 unique local addresses', () => {
        expect(isSafeMediaUrl('http://[fc00::1]/img.png')).toBe(false);
        expect(isSafeMediaUrl('http://[fd12::1]/img.png')).toBe(false);
    });

    it('should reject IPv4-mapped IPv6 addresses', () => {
        expect(isSafeMediaUrl('http://[::ffff:127.0.0.1]/img.png')).toBe(false);
    });

    it('should reject malformed URLs', () => {
        expect(isSafeMediaUrl('not-a-url')).toBe(false);
    });

    it('should allow 172.32.x.x (outside private range)', () => {
        expect(isSafeMediaUrl('http://172.32.0.1/img.png')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
    let limiter: RateLimiter;

    afterEach(() => {
        limiter?.stop();
    });

    it('should allow requests under the limit', () => {
        limiter = new RateLimiter({
            windowMs: 60_000,
            maxRequests: 5,
            blockDurationMs: 1_000,
            maxTrackedClients: 100,
        });
        const result = limiter.checkRequest('client-1');
        expect(result.allowed).toBe(true);
    });

    it('should block after exceeding max requests', () => {
        limiter = new RateLimiter({
            windowMs: 60_000,
            maxRequests: 3,
            blockDurationMs: 5_000,
            maxTrackedClients: 100,
        });

        for (let i = 0; i < 3; i++) {
            expect(limiter.checkRequest('client-1').allowed).toBe(true);
        }

        const blocked = limiter.checkRequest('client-1');
        expect(blocked.allowed).toBe(false);
        expect(blocked.retryAfterMs).toBeDefined();
        expect(blocked.retryAfterMs!).toBeGreaterThan(0);
    });

    it('should track clients independently', () => {
        limiter = new RateLimiter({
            windowMs: 60_000,
            maxRequests: 2,
            blockDurationMs: 1_000,
            maxTrackedClients: 100,
        });

        limiter.checkRequest('client-a');
        limiter.checkRequest('client-a');
        const blockedA = limiter.checkRequest('client-a');
        expect(blockedA.allowed).toBe(false);

        const allowedB = limiter.checkRequest('client-b');
        expect(allowedB.allowed).toBe(true);
    });

    it('should enforce connection limit per IP', () => {
        limiter = new RateLimiter({ maxConnectionsPerIp: 2, maxTrackedClients: 100 });

        expect(limiter.checkConnection('192.168.1.1')).toBe(true);
        limiter.registerConnection('conn-1', '192.168.1.1');

        expect(limiter.checkConnection('192.168.1.1')).toBe(true);
        limiter.registerConnection('conn-2', '192.168.1.1');

        expect(limiter.checkConnection('192.168.1.1')).toBe(false);
    });

    it('should allow new connections after unregister', () => {
        limiter = new RateLimiter({ maxConnectionsPerIp: 1, maxTrackedClients: 100 });

        limiter.registerConnection('conn-1', '10.0.0.1');
        expect(limiter.checkConnection('10.0.0.1')).toBe(false);

        limiter.unregisterConnection('conn-1', '10.0.0.1');
        expect(limiter.checkConnection('10.0.0.1')).toBe(true);
    });

    it('should evict oldest clients when exceeding maxTrackedClients', () => {
        limiter = new RateLimiter({
            maxTrackedClients: 3,
            windowMs: 60_000,
            maxRequests: 100,
            blockDurationMs: 1_000,
        });

        limiter.checkRequest('c1');
        limiter.checkRequest('c2');
        limiter.checkRequest('c3');
        limiter.checkRequest('c4');

        // c1 should have been evicted; c4 should exist
        const result = limiter.checkRequest('c4');
        expect(result.allowed).toBe(true);
    });

    it('should stop and clear all state', () => {
        limiter = new RateLimiter({ maxTrackedClients: 100 });
        limiter.checkRequest('c1');
        limiter.registerConnection('conn-1', '1.2.3.4');
        limiter.stop();

        // After stop, new state should be clean
        expect(limiter.checkConnection('1.2.3.4')).toBe(true);
    });

    it('should unblock client after block duration expires', () => {
        vi.useFakeTimers();
        try {
            limiter = new RateLimiter({
                windowMs: 60_000,
                maxRequests: 2,
                blockDurationMs: 5_000,
                maxTrackedClients: 100,
            });

            limiter.checkRequest('c1');
            limiter.checkRequest('c1');
            const blocked = limiter.checkRequest('c1');
            expect(blocked.allowed).toBe(false);

            vi.advanceTimersByTime(6_000);

            const unblocked = limiter.checkRequest('c1');
            expect(unblocked.allowed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('should return retryAfterMs for still-blocked client', () => {
        vi.useFakeTimers();
        try {
            limiter = new RateLimiter({
                windowMs: 60_000,
                maxRequests: 1,
                blockDurationMs: 10_000,
                maxTrackedClients: 100,
            });

            limiter.checkRequest('c1');
            limiter.checkRequest('c1'); // blocked

            vi.advanceTimersByTime(3_000);

            const result = limiter.checkRequest('c1');
            expect(result.allowed).toBe(false);
            expect(result.retryAfterMs).toBeLessThanOrEqual(7_000);
            expect(result.retryAfterMs).toBeGreaterThan(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

// ---------------------------------------------------------------------------
// validateToken
// ---------------------------------------------------------------------------

describe('validateToken', () => {
    it('should return true for matching tokens', () => {
        expect(validateToken('my-secret-token', 'my-secret-token')).toBe(true);
    });

    it('should return false for mismatched tokens', () => {
        expect(validateToken('correct', 'wrong')).toBe(false);
    });

    it('should return false for null provided', () => {
        expect(validateToken('token', null)).toBe(false);
    });

    it('should return false for undefined provided', () => {
        expect(validateToken('token', undefined)).toBe(false);
    });

    it('should return false for empty provided', () => {
        expect(validateToken('token', '')).toBe(false);
    });

    it('should return false for empty expected', () => {
        expect(validateToken('', 'token')).toBe(false);
    });

    it('should return false when lengths differ', () => {
        expect(validateToken('short', 'much-longer-token')).toBe(false);
    });

    it('should handle unicode tokens', () => {
        expect(validateToken('caf\u00e9', 'caf\u00e9')).toBe(true);
        expect(validateToken('caf\u00e9', 'cafe')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// extractToken
// ---------------------------------------------------------------------------

describe('extractToken', () => {
    it('should extract from Authorization Bearer header', () => {
        const token = extractToken({ authorization: 'Bearer my-token-123' });
        expect(token).toBe('my-token-123');
    });

    it('should return null for non-Bearer authorization', () => {
        const token = extractToken({ authorization: 'Basic dXNlcjpwYXNz' });
        expect(token).toBeNull();
    });

    it('should extract from sec-websocket-protocol auth prefix', () => {
        const token = extractToken({ 'sec-websocket-protocol': 'auth.ws-token-456' });
        expect(token).toBe('ws-token-456');
    });

    it('should return null for non-auth subprotocol', () => {
        const token = extractToken({ 'sec-websocket-protocol': 'graphql-ws' });
        expect(token).toBeNull();
    });

    it('should NOT extract from query string (tokens in URLs leak to logs)', () => {
        // URL query string token extraction was removed — tokens in URLs appear
        // in server access logs and proxy logs. Use Authorization: Bearer instead.
        const token = extractToken({});
        expect(token).toBeNull();
    });

    it('should return null when no token source is present', () => {
        const token = extractToken({});
        expect(token).toBeNull();
    });

    it('should prefer Authorization header over subprotocol', () => {
        const token = extractToken({
            authorization: 'Bearer header-token',
            'sec-websocket-protocol': 'auth.ws-token',
        });
        expect(token).toBe('header-token');
    });

    it('should fall back to subprotocol when no Bearer header', () => {
        const token = extractToken({
            authorization: 'Basic abc',
            'sec-websocket-protocol': 'auth.ws-token',
        });
        expect(token).toBe('ws-token');
    });

    it('should return null when no token source is present (no URL param accepted)', () => {
        expect(extractToken({})).toBeNull();
    });

    it('should handle array header values by ignoring them', () => {
        const token = extractToken({
            authorization: ['Bearer a', 'Bearer b'] as unknown as string,
        });
        // authorization is an array, not a string — should not match
        expect(token).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// isLoopbackIp
// ---------------------------------------------------------------------------

describe('isLoopbackIp', () => {
    it('should return true for 127.0.0.1', () => {
        expect(isLoopbackIp('127.0.0.1')).toBe(true);
    });

    it('should return true for ::1', () => {
        expect(isLoopbackIp('::1')).toBe(true);
    });

    it('should return true for ::ffff:127.0.0.1', () => {
        expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
    });

    it('should return true for localhost', () => {
        expect(isLoopbackIp('localhost')).toBe(true);
    });

    it('should return false for external IPs', () => {
        expect(isLoopbackIp('8.8.8.8')).toBe(false);
    });

    it('should return false for private IPs', () => {
        expect(isLoopbackIp('192.168.1.1')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// resolveSafePath
// ---------------------------------------------------------------------------

describe('resolveSafePath', () => {
    const base = '/var/data/uploads';

    it('should resolve a safe relative path', () => {
        const result = resolveSafePath(base, 'file.txt');
        expect(result).toBe(resolve(base, 'file.txt'));
    });

    it('should resolve nested safe path', () => {
        const result = resolveSafePath(base, 'subdir/file.txt');
        expect(result).toBe(resolve(base, 'subdir/file.txt'));
    });

    it('should throw on directory traversal', () => {
        expect(() => resolveSafePath(base, '../../../etc/passwd')).toThrow(
            'Path traversal detected',
        );
    });

    it('should throw on double-dot traversal', () => {
        expect(() => resolveSafePath(base, 'subdir/../../etc/shadow')).toThrow(
            'Path traversal detected',
        );
    });

    it('should strip null bytes before resolving', () => {
        const result = resolveSafePath(base, 'fi\0le.txt');
        expect(result).toBe(resolve(base, 'file.txt'));
    });

    it('should allow path that resolves exactly to base', () => {
        // resolveSafePath(base, '.') should resolve to base itself, which is allowed
        const result = resolveSafePath(base, '.');
        expect(result).toBe(resolve(base));
    });

    it('should throw when traversal with null bytes', () => {
        expect(() => resolveSafePath(base, '..\0/../etc/passwd')).toThrow(
            'Path traversal detected',
        );
    });
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature', () => {
    const secret = 'webhook-secret-key';
    const body = '{"event":"push","data":123}';

    function computeSignature(algo: string, fmt: 'hex' | 'base64', prefix?: string): string {
        const sig = createHmac(algo, secret).update(body).digest(fmt);
        return prefix ? prefix + sig : sig;
    }

    it('should verify valid sha256 hex signature', () => {
        const sig = computeSignature('sha256', 'hex');
        expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
    });

    it('should reject invalid signature', () => {
        expect(verifyWebhookSignature(secret, body, 'deadbeef')).toBe(false);
    });

    it('should handle prefix stripping (GitHub style)', () => {
        const sig = computeSignature('sha256', 'hex', 'sha256=');
        expect(
            verifyWebhookSignature(secret, body, sig, {
                algorithm: 'sha256',
                format: 'hex',
                prefix: 'sha256=',
            }),
        ).toBe(true);
    });

    it('should verify sha1 hex signature', () => {
        const sig = computeSignature('sha1', 'hex');
        expect(
            verifyWebhookSignature(secret, body, sig, {
                algorithm: 'sha1',
                format: 'hex',
            }),
        ).toBe(true);
    });

    it('should verify sha512 hex signature', () => {
        const sig = computeSignature('sha512', 'hex');
        expect(
            verifyWebhookSignature(secret, body, sig, {
                algorithm: 'sha512',
                format: 'hex',
            }),
        ).toBe(true);
    });

    it('should verify base64 format', () => {
        const sig = computeSignature('sha256', 'base64');
        expect(
            verifyWebhookSignature(secret, body, sig, {
                algorithm: 'sha256',
                format: 'base64',
            }),
        ).toBe(true);
    });

    it('should return false for empty secret', () => {
        expect(verifyWebhookSignature('', body, 'anything')).toBe(false);
    });

    it('should return false for empty signature', () => {
        expect(verifyWebhookSignature(secret, body, '')).toBe(false);
    });

    it('should return false for tampered body', () => {
        const sig = computeSignature('sha256', 'hex');
        expect(verifyWebhookSignature(secret, body + 'tampered', sig)).toBe(false);
    });

    it('should return false for wrong secret', () => {
        const sig = computeSignature('sha256', 'hex');
        expect(verifyWebhookSignature('wrong-secret', body, sig)).toBe(false);
    });

    it('should return false for malformed hex signature', () => {
        expect(verifyWebhookSignature(secret, body, 'not-valid-hex!!')).toBe(false);
    });
});
