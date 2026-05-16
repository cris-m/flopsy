import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChannelHealthMonitor } from '../src/proactive/health/monitor';
import type { Channel, ChannelStatus } from '../src/types';

/**
 * Lightweight channel double — only exposes the fields the health monitor
 * touches. Status is mutable so individual tests can simulate connect /
 * disconnect transitions.
 */
function makeChannel(name: string, initialStatus: ChannelStatus = 'connected') {
    const channel = {
        name,
        status: initialStatus as ChannelStatus,
        connect: vi.fn().mockImplementation(async () => {
            channel.status = 'connected';
        }),
        disconnect: vi.fn().mockImplementation(async () => {
            channel.status = 'disconnected';
        }),
    } as unknown as Channel & {
        connect: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
        status: ChannelStatus;
    };
    return channel;
}

function runChecks(monitor: ChannelHealthMonitor, channels: Map<string, Channel>, count: number) {
    // The monitor's `check()` is private; we drive it through the public
    // `start()` + setInterval. Easier path: poke the timer via fake timers.
    monitor.start(() => channels);
    for (let i = 0; i < count; i++) {
        vi.advanceTimersByTime(30_000); // matches DEFAULTS.checkIntervalMs
    }
}

describe('ChannelHealthMonitor — status-driven', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('NEVER restarts a channel that stays connected — regression test for the 10-min idle restart bug', async () => {
        // Pre-fix behavior: idle 10 min → forced disconnect+reconnect even
        // though channel was healthy. This test locks that down.
        const ch = makeChannel('telegram', 'connected');
        const monitor = new ChannelHealthMonitor({ connectGraceMs: 0 });

        runChecks(monitor, new Map([['telegram', ch]]), 200); // 200 × 30s = 100 min

        expect(ch.disconnect).not.toHaveBeenCalled();
        expect(ch.connect).not.toHaveBeenCalled();
    });

    it('reconnects a channel that becomes disconnected', async () => {
        const ch = makeChannel('telegram', 'connected');
        const monitor = new ChannelHealthMonitor({ connectGraceMs: 0 });
        monitor.start(() => new Map([['telegram', ch]]));

        // First tick: still connected, no action.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ch.disconnect).not.toHaveBeenCalled();

        // Channel goes down.
        ch.status = 'disconnected';
        await vi.advanceTimersByTimeAsync(30_000);

        // Reconnect attempted: disconnect() (clean state) then connect().
        expect(ch.disconnect).toHaveBeenCalledTimes(1);
        expect(ch.connect).toHaveBeenCalledTimes(1);
    });

    it('respects connectGraceMs — does NOT intervene before grace expires', async () => {
        const ch = makeChannel('telegram', 'disconnected');
        const monitor = new ChannelHealthMonitor({ connectGraceMs: 60_000 });
        monitor.start(() => new Map([['telegram', ch]]));

        // 30s tick — still inside grace.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ch.connect).not.toHaveBeenCalled();

        // Past grace.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(ch.connect).toHaveBeenCalled();
    });

    it('applies exponential backoff between reconnect attempts on repeated failure', async () => {
        const ch = makeChannel('telegram', 'disconnected');
        // Make connect always fail to drive consecutive failures.
        ch.connect.mockImplementation(async () => {
            throw new Error('upstream down');
        });
        const monitor = new ChannelHealthMonitor({ connectGraceMs: 0 });
        monitor.start(() => new Map([['telegram', ch]]));

        // First attempt — fires on the first tick (no backoff yet).
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ch.connect).toHaveBeenCalledTimes(1);

        // Backoff after 1st failure: ~5s base × 2^1 = 10s. Next 30s tick
        // is well past that, so the second attempt should fire.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ch.connect).toHaveBeenCalledTimes(2);

        // Backoff after 2nd failure: 5s × 2^2 = 20s. Still < 30s tick.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ch.connect).toHaveBeenCalledTimes(3);

        // After 3rd failure: 5s × 2^3 = 40s. A 30s tick should NOT yet
        // trigger a 4th attempt (backoff not elapsed).
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ch.connect).toHaveBeenCalledTimes(3);

        // Advance past the 40s backoff.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ch.connect).toHaveBeenCalledTimes(4);
    });

    it('honors maxRestartsPerHour cap', async () => {
        const ch = makeChannel('telegram', 'disconnected');
        ch.connect.mockImplementation(async () => {
            throw new Error('still down');
        });
        const monitor = new ChannelHealthMonitor({
            connectGraceMs: 0,
            maxRestartsPerHour: 3,
        });
        monitor.start(() => new Map([['telegram', ch]]));

        // Drive a long simulated period — plenty of time for backoff but
        // capped at 3 attempts/hour.
        for (let i = 0; i < 20; i++) {
            await vi.advanceTimersByTimeAsync(60_000); // 1 minute each
        }

        expect(ch.connect.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('resets consecutive-failure counter on successful reconnect', async () => {
        const ch = makeChannel('telegram', 'disconnected');
        // Two failures, then succeed.
        ch.connect
            .mockImplementationOnce(async () => { throw new Error('blip 1'); })
            .mockImplementationOnce(async () => { throw new Error('blip 2'); })
            .mockImplementation(async () => { ch.status = 'connected'; });

        const monitor = new ChannelHealthMonitor({ connectGraceMs: 0 });
        monitor.start(() => new Map([['telegram', ch]]));

        // Drive enough ticks past each backoff window.
        for (let i = 0; i < 10; i++) {
            await vi.advanceTimersByTimeAsync(30_000);
        }

        // After success, channel is connected — no further attempts.
        expect(ch.status).toBe('connected');
        const attemptsAtSuccess = ch.connect.mock.calls.length;

        // Run more ticks — no additional reconnect should fire on a
        // healthy channel.
        for (let i = 0; i < 10; i++) {
            await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(ch.connect.mock.calls.length).toBe(attemptsAtSuccess);
    });

    it('recordEvent is preserved as a callable but does NOT influence restart decisions', async () => {
        // Pre-fix: a channel "without recent events" was force-restarted.
        // Post-fix: only `channel.status` decides. Calling recordEvent does
        // nothing observable; not calling it also does nothing.
        const ch = makeChannel('telegram', 'connected');
        const monitor = new ChannelHealthMonitor({ connectGraceMs: 0 });
        monitor.start(() => new Map([['telegram', ch]]));

        // No recordEvent calls — pre-fix would have flagged this stale.
        for (let i = 0; i < 50; i++) {
            await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(ch.connect).not.toHaveBeenCalled();
        expect(ch.disconnect).not.toHaveBeenCalled();

        // Calling recordEvent doesn't trigger anything either.
        monitor.recordEvent('telegram');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(ch.connect).not.toHaveBeenCalled();
    });

    it('stops cleanly when stop() is called', async () => {
        const ch = makeChannel('telegram', 'disconnected');
        const monitor = new ChannelHealthMonitor({ connectGraceMs: 0 });
        monitor.start(() => new Map([['telegram', ch]]));

        await vi.advanceTimersByTimeAsync(30_000);
        const callsBeforeStop = ch.connect.mock.calls.length;
        expect(callsBeforeStop).toBeGreaterThan(0);

        monitor.stop();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(ch.connect.mock.calls.length).toBe(callsBeforeStop);
    });
});
