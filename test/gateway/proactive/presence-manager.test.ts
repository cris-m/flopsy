/**
 * PresenceManager — the suppression gate that runs BEFORE every proactive
 * delivery. A wrong answer here either spams the user during quiet hours
 * (false positive on `suppress: false`) or silently swallows real signal
 * (false positive on `suppress: true`). Both are user-visible failures.
 *
 * Covers:
 *   - shouldSuppress: quiet hours, DND status, expiry handling
 *   - setExplicitStatus / clearExplicitStatus
 *   - setQuietHours
 *   - isInActiveHours: same-day window vs. wrap-around (e.g. 22h–6h)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PresenceManager, StateStore } from '@flopsy/gateway/proactive';

let tmpDir: string;
let store: StateStore;
let presence: PresenceManager;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flopsy-presence-test-'));
    store = new StateStore(join(tmpDir, 'state.json'));
    presence = new PresenceManager(store);
});

afterEach(() => {
    store.stop();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
});

describe('PresenceManager.shouldSuppress', () => {
    it('returns suppress=false when no presence state is set', async () => {
        const r = await presence.shouldSuppress();
        expect(r.suppress).toBe(false);
    });

    it('suppresses during quiet hours', async () => {
        const future = Date.now() + 60_000;
        await presence.setQuietHours(future);
        const r = await presence.shouldSuppress();
        expect(r.suppress).toBe(true);
        expect(r.reason).toMatch(/quiet hours/i);
    });

    it('does NOT suppress once quiet-hours window has passed', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-04-29T12:00:00Z'));
            await presence.setQuietHours(Date.now() + 60_000);
            // 2 minutes later — past the 1-minute quiet window.
            vi.setSystemTime(new Date('2026-04-29T12:02:00Z'));
            const r = await presence.shouldSuppress();
            expect(r.suppress).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('suppresses while DND is active', async () => {
        await presence.setExplicitStatus('dnd', 60_000, 'in a meeting');
        const r = await presence.shouldSuppress();
        expect(r.suppress).toBe(true);
        expect(r.reason).toMatch(/dnd until/);
    });

    it('does NOT suppress once DND has expired', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-04-29T12:00:00Z'));
            await presence.setExplicitStatus('dnd', 60_000);
            vi.setSystemTime(new Date('2026-04-29T12:02:00Z'));
            const r = await presence.shouldSuppress();
            expect(r.suppress).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('clearExplicitStatus removes DND immediately', async () => {
        await presence.setExplicitStatus('dnd', 60_000);
        await presence.clearExplicitStatus();
        const r = await presence.shouldSuppress();
        expect(r.suppress).toBe(false);
    });

    it('quiet hours wins when both quiet hours AND DND are active', async () => {
        await presence.setExplicitStatus('dnd', 60_000);
        await presence.setQuietHours(Date.now() + 60_000);
        const r = await presence.shouldSuppress();
        expect(r.suppress).toBe(true);
        // The quiet-hours branch is checked first in the code; reason reflects that.
        expect(r.reason).toMatch(/quiet hours/i);
    });
});

describe('PresenceManager.isInActiveHours', () => {
    // We force a known current hour by using a fixed system time with a
    // known timezone. UTC is the simplest; the computed "current hour"
    // depends on the value passed via the `timezone` arg.
    function withFixedHour(utcHour: number) {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(`2026-04-29T${utcHour.toString().padStart(2, '0')}:30:00Z`));
    }

    afterEach(() => {
        vi.useRealTimers();
    });

    it('same-day window: 9..17 includes 12, excludes 8 and 17', async () => {
        withFixedHour(12);
        expect(await presence.isInActiveHours(9, 17, 'UTC')).toBe(true);
        withFixedHour(8);
        expect(await presence.isInActiveHours(9, 17, 'UTC')).toBe(false);
        withFixedHour(17);
        // upper bound is exclusive
        expect(await presence.isInActiveHours(9, 17, 'UTC')).toBe(false);
    });

    it('wrap-around window: 22..6 includes 23 and 3, excludes 12', async () => {
        withFixedHour(23);
        expect(await presence.isInActiveHours(22, 6, 'UTC')).toBe(true);
        withFixedHour(3);
        expect(await presence.isInActiveHours(22, 6, 'UTC')).toBe(true);
        withFixedHour(12);
        expect(await presence.isInActiveHours(22, 6, 'UTC')).toBe(false);
    });

    it('wrap-around boundary: hour exactly equals start is included', async () => {
        withFixedHour(22);
        expect(await presence.isInActiveHours(22, 6, 'UTC')).toBe(true);
    });

    it('honors a non-UTC timezone string', async () => {
        // 12 UTC = 21 in Asia/Tokyo (UTC+9). 18..22 should include 21.
        withFixedHour(12);
        expect(await presence.isInActiveHours(18, 22, 'Asia/Tokyo')).toBe(true);
        // Same UTC time = 12 in UTC. 18..22 should NOT include 12.
        expect(await presence.isInActiveHours(18, 22, 'UTC')).toBe(false);
    });
});
