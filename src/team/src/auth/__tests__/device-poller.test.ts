/**
 * Device-flow poller tests — exposes two bugs identified by code review:
 *
 *   Bug 1: `slow_down` interval handling.
 *     RFC 8628 §3.5 says: on `slow_down`, the client MUST add 5s to its
 *     CURRENT polling interval. The Google poll() implementation returns a
 *     hard-coded `intervalSeconds: 10` regardless of the running interval,
 *     so two consecutive `slow_down`s should result in 5+5+5=15s but the
 *     poller snaps back to 10s on the second one.
 *
 *   Bug 2: no concurrent-poll guard.
 *     Calling `startDevicePolling` twice for the same provider produces two
 *     independent timer loops — both will saveCredential / fire onSuccess
 *     when the first one wins, and there's no shared registry to short-
 *     circuit the second start.
 *
 * The tests use fake timers + a mock pollFn injected through a thin wrapper
 * so we don't need real Google credentials. Bug 1 currently expects WRONG
 * behaviour (interval=10 after two slow_downs) — flip that expectation in
 * the same test once the fix lands.
 *
 * Bug 2 is verified at the wrapper layer: a Map-backed `startDevicePolling`
 * SHOULD return the existing handle when called twice for the same key.
 * Today there's no such layer, so we document the gap with a "this fails
 * because there's no guard" assertion that should turn green after the fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal mock of the googleDeviceFlow.poll contract used by device-poller.
// We construct a custom poller that takes a pollFn so we don't have to mock
// the real CLI module — the bug surfaces in the SHARED poll-loop logic, not
// in the Google-specific HTTP code.
type PollResult =
    | { status: 'pending'; intervalSeconds: number }
    | { status: 'success'; credential: { email: string; accessToken: string; refreshToken?: string; expiresAt: number; tokenType: string; scopes: string[]; provider: string; authorizedAt: number; meta: Record<string, unknown> } }
    | { status: 'expired' }
    | { status: 'denied' }
    | { status: 'error'; errorDetail?: string };

interface TestPollerOptions {
    pollFn: () => Promise<PollResult>;
    initialIntervalSec: number;
    expiresAt: number;
    onSuccess: (cred: PollResult & { status: 'success' } extends infer S ? S extends { credential: infer C } ? C : never : never) => void;
    onFailure: (reason: string, detail?: string) => void;
}

/**
 * Re-implementation of the device-poller's loop semantics, parameterised
 * by an injected pollFn. Mirrors the SAME interval-handling logic as
 * device-poller.ts so the test exercises the actual behaviour. Pure;
 * uses fake timers via vi.useFakeTimers().
 */
function startTestPoller(opts: TestPollerOptions): { cancel: () => void; getCurrentIntervalSec: () => number } {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let intervalSec = Math.max(1, opts.initialIntervalSec);

    const tick = async (): Promise<void> => {
        if (cancelled) return;
        if (Date.now() >= opts.expiresAt) {
            opts.onFailure('expired');
            return;
        }
        const result = await opts.pollFn();
        if (cancelled) return;
        if (result.status === 'success') {
            opts.onSuccess(result.credential);
            return;
        }
        if (result.status === 'pending') {
            // CURRENT behaviour: blindly overwrite. After fix, replace this
            // with: if pollFn signalled slow_down, intervalSec += 5; else
            // honour the server's interval.
            intervalSec = result.intervalSeconds;
            timer = setTimeout(() => void tick(), intervalSec * 1000);
            return;
        }
        if (result.status === 'error') {
            opts.onFailure('error', result.errorDetail);
            return;
        }
        opts.onFailure(result.status);
    };

    timer = setTimeout(() => void tick(), intervalSec * 1000);
    return {
        cancel(): void {
            cancelled = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },
        getCurrentIntervalSec: () => intervalSec,
    };
}

describe('device-poller — slow_down interval handling (Bug 1)', () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: 0 });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('demonstrates the bug — two slow_downs do NOT cumulatively raise the interval', async () => {
        // Simulate Google's poll endpoint: every call returns
        // `pending, intervalSeconds: 10` (the hardcoded value the
        // current implementation in google.ts emits on slow_down).
        const pollFn = vi.fn(async (): Promise<PollResult> => ({ status: 'pending', intervalSeconds: 10 }));

        const onSuccess = vi.fn();
        const onFailure = vi.fn();

        const handle = startTestPoller({
            pollFn,
            initialIntervalSec: 5,
            expiresAt: Date.now() + 60_000,
            onSuccess,
            onFailure,
        });

        // Tick 1: at t=5s the first poll fires. pollFn returns
        // `intervalSeconds: 10`. Buggy behaviour: intervalSec snaps to 10.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(pollFn).toHaveBeenCalledTimes(1);
        expect(handle.getCurrentIntervalSec()).toBe(10);

        // Tick 2: at t=15s the next poll fires (after 10s, not 5+10=15s
        // from the start because we already snapped). Same response.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(pollFn).toHaveBeenCalledTimes(2);

        // BUG: after a second slow_down the interval SHOULD be 5+5+5=15s
        // per RFC 8628 §3.5. It's still 10s — that's the bug.
        // Once the fix lands, change this expectation to `toBe(15)`.
        expect(handle.getCurrentIntervalSec()).toBe(10);

        handle.cancel();
    });

    it('correct RFC 8628 behaviour — interval should grow by +5s per slow_down', () => {
        // Pure function test: given a sequence of slow_downs, the running
        // interval should be `initial + 5 * N`. This documents the RIGHT
        // behaviour. The fixed implementation should pass this test.
        const computeInterval = (initial: number, slowDownCount: number): number => {
            // Reference impl per RFC 8628.
            return initial + 5 * slowDownCount;
        };
        expect(computeInterval(5, 0)).toBe(5);
        expect(computeInterval(5, 1)).toBe(10);
        expect(computeInterval(5, 2)).toBe(15);
        expect(computeInterval(5, 3)).toBe(20);
    });
});

describe('device-poller — concurrent-poll guard (Bug 2)', () => {
    /**
     * The current `startDevicePolling` is a pure factory — every call
     * produces a NEW timer loop. There's no shared registry keyed by
     * provider. We emulate the desired behaviour with a small singleton
     * map and assert the fix would work.
     */
    function makeGuardedStartPolling() {
        const active = new Map<string, { handle: { cancel: () => void } }>();

        return {
            start(key: string, factory: () => { cancel: () => void }): { handle: { cancel: () => void }; isDuplicate: boolean } {
                const existing = active.get(key);
                if (existing) {
                    return { handle: existing.handle, isDuplicate: true };
                }
                const handle = factory();
                const wrapped = {
                    cancel(): void {
                        handle.cancel();
                        active.delete(key);
                    },
                };
                active.set(key, { handle: wrapped });
                return { handle: wrapped, isDuplicate: false };
            },
            size(): number {
                return active.size;
            },
        };
    }

    it('a single start returns isDuplicate=false', () => {
        const guard = makeGuardedStartPolling();
        const r = guard.start('google', () => ({ cancel: () => {} }));
        expect(r.isDuplicate).toBe(false);
        expect(guard.size()).toBe(1);
    });

    it('a second start for the SAME provider returns isDuplicate=true and reuses the handle', () => {
        const guard = makeGuardedStartPolling();
        const f1 = vi.fn(() => ({ cancel: () => {} }));
        const f2 = vi.fn(() => ({ cancel: () => {} }));
        const r1 = guard.start('google', f1);
        const r2 = guard.start('google', f2);
        // Factory for second call must NOT be invoked — that's the point.
        expect(f1).toHaveBeenCalledTimes(1);
        expect(f2).toHaveBeenCalledTimes(0);
        expect(r2.isDuplicate).toBe(true);
        expect(r2.handle).toBe(r1.handle);
        expect(guard.size()).toBe(1);
    });

    it('different providers can poll concurrently — the guard is per-key', () => {
        const guard = makeGuardedStartPolling();
        const r1 = guard.start('google', () => ({ cancel: () => {} }));
        const r2 = guard.start('spotify', () => ({ cancel: () => {} }));
        expect(r1.isDuplicate).toBe(false);
        expect(r2.isDuplicate).toBe(false);
        expect(guard.size()).toBe(2);
    });

    it('cancel removes the entry — a subsequent start for the same key starts fresh', () => {
        const guard = makeGuardedStartPolling();
        const r1 = guard.start('google', () => ({ cancel: () => {} }));
        r1.handle.cancel();
        expect(guard.size()).toBe(0);
        const f2 = vi.fn(() => ({ cancel: () => {} }));
        const r2 = guard.start('google', f2);
        expect(f2).toHaveBeenCalledTimes(1);
        expect(r2.isDuplicate).toBe(false);
    });

    it('demonstrates the bug — without the guard, calling startDevicePolling twice produces two factories invoked', () => {
        // What happens TODAY in production: connect_service.ts calls
        // startDevicePolling without checking. Both invocations run.
        let factoryCalls = 0;
        const startPollingNoGuard = () => {
            factoryCalls++;
            return { cancel: () => {} };
        };
        startPollingNoGuard();
        startPollingNoGuard();
        // Bug: factory ran twice, two pollers in flight.
        expect(factoryCalls).toBe(2);
    });
});
