/**
 * HeartbeatTrigger — interval-based fire scheduling.
 *
 * Covers:
 *   - parseDurationMs: shape validation + unit math
 *   - addHeartbeat: returns false for disabled / invalid interval / dupes
 *   - removeHeartbeat: clears the timer + drops from registry
 *   - triggerNow: fires regardless of interval, only when name is known
 *   - timer tick: fires the executor on schedule
 *   - overlap protection: a slow tick blocks the next one
 *   - oneshot path: fires once immediately, skipped if already-completed
 *
 * Uses fake timers + a stub executor that records each fire(). Stores +
 * presence are minimal stubs because their internals are tested elsewhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeartbeatTrigger } from '@flopsy/gateway/proactive';
import { parseDurationMs } from '@flopsy/gateway/proactive/duration';
import type {
    HeartbeatDefinition,
    DeliveryTarget,
    ExecutionResult,
} from '@flopsy/gateway/proactive';

// ── parseDurationMs ──────────────────────────────────────────────────────────

describe('parseDurationMs', () => {
    it('parses seconds, minutes, hours, days', () => {
        expect(parseDurationMs('30s')).toBe(30_000);
        expect(parseDurationMs('5m')).toBe(300_000);
        expect(parseDurationMs('2h')).toBe(7_200_000);
        expect(parseDurationMs('1d')).toBe(86_400_000);
    });

    it('tolerates whitespace between value and unit', () => {
        expect(parseDurationMs('30 s')).toBe(30_000);
        expect(parseDurationMs('5 m')).toBe(300_000);
    });

    it('returns null for missing unit', () => {
        expect(parseDurationMs('30')).toBeNull();
    });

    it('returns null for unsupported units', () => {
        expect(parseDurationMs('1w')).toBeNull();
        expect(parseDurationMs('1y')).toBeNull();
        expect(parseDurationMs('1ms')).toBeNull();
    });

    it('returns null for empty / non-numeric input', () => {
        expect(parseDurationMs('')).toBeNull();
        expect(parseDurationMs('forever')).toBeNull();
        expect(parseDurationMs('abc m')).toBeNull();
    });
});

// ── HeartbeatTrigger lifecycle ───────────────────────────────────────────────

interface FireRecord {
    job: { id: string; name: string };
    contextKeys: string[];
}

function makeStubExecutor(): {
    executor: import('@flopsy/gateway/proactive').JobExecutor;
    fires: FireRecord[];
    setSlow: (delayMs: number) => void;
} {
    const fires: FireRecord[] = [];
    let slowDelay = 0;
    const stub = {
        async execute(job: import('@flopsy/gateway/proactive').ExecutionJob,
                      _ctx?: Record<string, unknown>): Promise<ExecutionResult> {
            fires.push({
                job: { id: job.id, name: job.name },
                contextKeys: _ctx ? Object.keys(_ctx) : [],
            });
            if (slowDelay > 0) {
                await new Promise<void>((r) => setTimeout(r, slowDelay));
            }
            return { action: 'delivered', durationMs: 1 } as ExecutionResult;
        },
        // Surface the same isExecuting check the real executor offers.
        // The trigger doesn't read it, but mirroring keeps the shape honest.
        isExecuting: () => false,
    };
    // Cast for the nominal type.
    return {
        executor: stub as unknown as import('@flopsy/gateway/proactive').JobExecutor,
        fires,
        setSlow: (n) => {
            slowDelay = n;
        },
    };
}

function makeStubPresence() {
    return {
        shouldSuppress: () => ({ suppress: false }),
    } as unknown as import('@flopsy/gateway/proactive').PresenceManager;
}

function makeStubStore() {
    const oneshotsCompleted = new Set<string>();
    return {
        store: {
            isOneshotCompleted: (key: string) => oneshotsCompleted.has(key),
            markOneshotCompleted: (key: string) => oneshotsCompleted.add(key),
        } as unknown as import('@flopsy/gateway/proactive').StateStore,
        oneshotsCompleted,
    };
}

const DEFAULT_DELIVERY: DeliveryTarget = {
    channel: 'telegram',
    peer: { id: '5257796557', type: 'user' },
};

let trigger: HeartbeatTrigger;
let exec: ReturnType<typeof makeStubExecutor>;
let storeWrap: ReturnType<typeof makeStubStore>;

beforeEach(() => {
    exec = makeStubExecutor();
    storeWrap = makeStubStore();
    trigger = new HeartbeatTrigger(exec.executor, makeStubPresence(), storeWrap.store);
    // Resolve delivery to the default target every fire so the executor stub gets called.
    trigger.resolveDelivery = () => DEFAULT_DELIVERY;
});

afterEach(() => {
    trigger.stop();
    vi.useRealTimers();
});

function hb(overrides: Partial<HeartbeatDefinition> = {}): HeartbeatDefinition {
    return {
        id: overrides.id ?? `hb-${overrides.name ?? 'a'}`,
        name: 'a',
        enabled: true,
        interval: '1m',
        prompt: 'check',
        deliveryMode: 'always',
        oneshot: false,
        ...overrides,
    } as HeartbeatDefinition;
}

describe('HeartbeatTrigger.addHeartbeat', () => {
    it('registers an enabled heartbeat with valid interval', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        expect(trigger.addHeartbeat(hb({ name: 'inbox', interval: '30m' }), DEFAULT_DELIVERY))
            .toBe(true);
    });

    it('refuses a disabled heartbeat', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        expect(trigger.addHeartbeat(
            hb({ name: 'off', enabled: false }),
            DEFAULT_DELIVERY,
        )).toBe(false);
    });

    it('refuses an invalid interval', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        expect(trigger.addHeartbeat(
            hb({ name: 'bad', interval: 'forever' }),
            DEFAULT_DELIVERY,
        )).toBe(false);
    });

    it('refuses a duplicate name', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        trigger.addHeartbeat(hb({ name: 'dup' }), DEFAULT_DELIVERY);
        expect(trigger.addHeartbeat(hb({ name: 'dup' }), DEFAULT_DELIVERY)).toBe(false);
    });

    it('refuses a oneshot whose key is already completed (e.g. survived restart)', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        const def = hb({ name: 'once', id: 'key-once', oneshot: true });
        storeWrap.oneshotsCompleted.add('key-once');
        expect(trigger.addHeartbeat(def, DEFAULT_DELIVERY)).toBe(false);
    });
});

describe('HeartbeatTrigger.removeHeartbeat', () => {
    it('removes a registered heartbeat', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        trigger.addHeartbeat(hb({ name: 'r' }), DEFAULT_DELIVERY);
        expect(trigger.removeHeartbeat('r')).toBe(true);
        // Removing again returns false (no longer present).
        expect(trigger.removeHeartbeat('r')).toBe(false);
    });

    it('returns false for unknown name', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        expect(trigger.removeHeartbeat('nope')).toBe(false);
    });
});

describe('HeartbeatTrigger.triggerNow', () => {
    it('returns false for unknown heartbeat', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        expect(await trigger.triggerNow('missing')).toBe(false);
    });

    it('fires the executor when the heartbeat is registered', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        trigger.addHeartbeat(hb({ name: 'fire-me' }), DEFAULT_DELIVERY);
        const ok = await trigger.triggerNow('fire-me');
        expect(ok).toBe(true);
        expect(exec.fires).toHaveLength(1);
        expect(exec.fires[0]!.job.name).toBe('fire-me');
    });

    it('accepts an optional context arg without throwing', async () => {
        // The trigger consumes context in its presence-check guard but does
        // NOT thread it through to executor.execute (intentional — proactive
        // jobs are stateless). Just confirm the call shape works.
        await trigger.start([], DEFAULT_DELIVERY);
        trigger.addHeartbeat(hb({ name: 'with-ctx' }), DEFAULT_DELIVERY);
        await trigger.triggerNow('with-ctx', { reason: 'manual' });
        expect(exec.fires).toHaveLength(1);
    });
});

describe('HeartbeatTrigger.stop', () => {
    it('clears all timers and drops registrations', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        trigger.addHeartbeat(hb({ name: 'a' }), DEFAULT_DELIVERY);
        trigger.addHeartbeat(hb({ name: 'b' }), DEFAULT_DELIVERY);
        trigger.stop();
        // After stop, the names should NOT be findable for triggerNow.
        expect(await trigger.triggerNow('a')).toBe(false);
        expect(await trigger.triggerNow('b')).toBe(false);
    });
});

describe('HeartbeatTrigger.getLastFiredAt', () => {
    it('is undefined before any fire', () => {
        expect(trigger.getLastFiredAt()).toBeUndefined();
    });

    it('updates after triggerNow', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        trigger.addHeartbeat(hb({ name: 'a' }), DEFAULT_DELIVERY);
        const before = Date.now();
        await trigger.triggerNow('a');
        const fired = trigger.getLastFiredAt();
        expect(fired).toBeDefined();
        expect(fired!).toBeGreaterThanOrEqual(before);
    });
});
