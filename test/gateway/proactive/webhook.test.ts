/**
 * Webhook surface tests:
 *   - verifyWebhookSignature: HMAC verification across algorithms / formats / prefixes
 *   - WebhookRouter.addRuntimeRoute / removeRuntimeRoute: runtime registration
 *     before vs after `register()`, no-op for unknown paths.
 *
 * The full HTTP flow (request → signature check → channel push) is left
 * for an end-to-end test; these tests cover the security primitive and the
 * registry bookkeeping that drives `manage_schedule` webhook ops.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '@flopsy/gateway/core/security';
import { WebhookRouter, type ExternalWebhookConfig } from '@flopsy/gateway/core/webhook-router';

// ── verifyWebhookSignature ──────────────────────────────────────────────────

describe('verifyWebhookSignature — algorithms', () => {
    const SECRET = 'shared-secret';
    const BODY = '{"hello":"world"}';

    function sign(alg: 'sha1' | 'sha256' | 'sha512', fmt: 'hex' | 'base64'): string {
        return createHmac(alg, SECRET).update(BODY).digest(fmt);
    }

    it('verifies sha256 hex (default)', () => {
        const sig = sign('sha256', 'hex');
        expect(verifyWebhookSignature(SECRET, BODY, sig)).toBe(true);
    });

    it('verifies sha1 hex', () => {
        const sig = sign('sha1', 'hex');
        expect(verifyWebhookSignature(SECRET, BODY, sig, {
            algorithm: 'sha1', format: 'hex',
        })).toBe(true);
    });

    it('verifies sha512 hex', () => {
        const sig = sign('sha512', 'hex');
        expect(verifyWebhookSignature(SECRET, BODY, sig, {
            algorithm: 'sha512', format: 'hex',
        })).toBe(true);
    });

    it('verifies sha256 base64', () => {
        const sig = sign('sha256', 'base64');
        expect(verifyWebhookSignature(SECRET, BODY, sig, {
            algorithm: 'sha256', format: 'base64',
        })).toBe(true);
    });

    it('strips a configured prefix before comparing', () => {
        const sig = 'sha256=' + sign('sha256', 'hex');
        expect(verifyWebhookSignature(SECRET, BODY, sig, {
            algorithm: 'sha256', format: 'hex', prefix: 'sha256=',
        })).toBe(true);
    });
});

describe('verifyWebhookSignature — rejection cases', () => {
    const SECRET = 'shared-secret';
    const BODY = '{"hello":"world"}';

    it('rejects when signature does not match', () => {
        const tampered = createHmac('sha256', 'wrong-secret').update(BODY).digest('hex');
        expect(verifyWebhookSignature(SECRET, BODY, tampered)).toBe(false);
    });

    it('rejects when body has been mutated', () => {
        const sig = createHmac('sha256', SECRET).update(BODY).digest('hex');
        expect(verifyWebhookSignature(SECRET, BODY + ' tampered', sig)).toBe(false);
    });

    it('rejects when secret is empty', () => {
        const sig = createHmac('sha256', SECRET).update(BODY).digest('hex');
        expect(verifyWebhookSignature('', BODY, sig)).toBe(false);
    });

    it('rejects when signature is empty', () => {
        expect(verifyWebhookSignature(SECRET, BODY, '')).toBe(false);
    });

    it('rejects when signature length is wrong (avoids timingSafeEqual throw)', () => {
        // timingSafeEqual throws if buffers differ in length — the function
        // catches it and returns false rather than propagating the throw.
        expect(verifyWebhookSignature(SECRET, BODY, 'short')).toBe(false);
    });

    it('rejects when format mismatches the encoded signature', () => {
        // Sig was produced as hex but verifier is told it's base64 — should
        // not crash, just return false.
        const hexSig = createHmac('sha256', SECRET).update(BODY).digest('hex');
        expect(verifyWebhookSignature(SECRET, BODY, hexSig, {
            algorithm: 'sha256', format: 'base64',
        })).toBe(false);
    });
});

// ── WebhookRouter ───────────────────────────────────────────────────────────

interface FakeWebhookServerCalls {
    registered: Array<{ path: string }>;
    unregistered: string[];
}

function makeFakeServer(): {
    server: import('@flopsy/gateway/core/base-webhook').WebhookServer;
    calls: FakeWebhookServerCalls;
} {
    const calls: FakeWebhookServerCalls = { registered: [], unregistered: [] };
    const fake = {
        registerRoute: (path: string, _handler: unknown) => {
            calls.registered.push({ path });
        },
        unregisterRoute: (path: string) => {
            calls.unregistered.push(path);
            return calls.registered.some((r) => r.path === path);
        },
        respond: () => {},
    };
    return {
        server: fake as unknown as import('@flopsy/gateway/core/base-webhook').WebhookServer,
        calls,
    };
}

function makeFakeRouter(): import('@flopsy/gateway/core/message-router').MessageRouter {
    return {
        getOrCreate: () => null,
    } as unknown as import('@flopsy/gateway/core/message-router').MessageRouter;
}

const WEBHOOK_CFG: ExternalWebhookConfig = {
    name: 'github-test',
    path: '/webhook/github',
    targetChannel: 'telegram',
    secret: 'shh',
};

describe('WebhookRouter.addRuntimeRoute', () => {
    let router: WebhookRouter;
    let server: ReturnType<typeof makeFakeServer>;

    beforeEach(() => {
        router = new WebhookRouter([]);
        server = makeFakeServer();
    });

    it('returns false when called before register()', () => {
        expect(router.addRuntimeRoute(WEBHOOK_CFG)).toBe(false);
        expect(server.calls.registered).toHaveLength(0);
    });

    it('registers the route after register() runs', () => {
        router.register(server.server, makeFakeRouter());
        const ok = router.addRuntimeRoute(WEBHOOK_CFG);
        expect(ok).toBe(true);
        expect(server.calls.registered.find((r) => r.path === WEBHOOK_CFG.path))
            .toBeDefined();
    });

    it('register() registers config-defined webhooks once', () => {
        const r = new WebhookRouter([WEBHOOK_CFG]);
        r.register(server.server, makeFakeRouter());
        expect(server.calls.registered).toHaveLength(1);
        expect(server.calls.registered[0]!.path).toBe('/webhook/github');
    });
});

describe('WebhookRouter.removeRuntimeRoute', () => {
    let router: WebhookRouter;
    let server: ReturnType<typeof makeFakeServer>;

    beforeEach(() => {
        router = new WebhookRouter([]);
        server = makeFakeServer();
        router.register(server.server, makeFakeRouter());
    });

    it('removes a runtime-added path', () => {
        router.addRuntimeRoute(WEBHOOK_CFG);
        expect(router.removeRuntimeRoute(WEBHOOK_CFG.path)).toBe(true);
        expect(server.calls.unregistered).toContain(WEBHOOK_CFG.path);
    });

    it('returns false for a path that was never runtime-added', () => {
        // config-defined paths are immutable — runtime-track set is empty.
        expect(router.removeRuntimeRoute('/webhook/never-added')).toBe(false);
    });

    it('does NOT remove a config-defined path (immutable by design)', () => {
        const r = new WebhookRouter([WEBHOOK_CFG]);
        r.register(server.server, makeFakeRouter());
        expect(r.removeRuntimeRoute(WEBHOOK_CFG.path)).toBe(false);
    });
});
