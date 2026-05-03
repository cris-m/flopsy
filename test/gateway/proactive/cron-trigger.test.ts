/**
 * CronTrigger — schedule-driven job firing (parallel of HeartbeatTrigger).
 *
 * Three schedule kinds:
 *   - `at`     fire once at absolute epoch ms (oneshot)
 *   - `every`  fire on fixed interval
 *   - `cron`   fire on 5-field cron expression with optional IANA tz
 *
 * Covers:
 *   - addJob / removeJob / listJobs / triggerNow basics
 *   - start() honors oneshot completion guard (skip already-completed)
 *   - start() handles past-due 'at' jobs:
 *       - within grace window → fire now
 *       - beyond grace window → mark complete + drop the row
 *   - stop() clears timers and registry
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CronTrigger, StateStore } from '@flopsy/gateway/proactive';
import type {
    JobDefinition,
    DeliveryTarget,
    ExecutionResult,
    JobExecutor,
} from '@flopsy/gateway/proactive';

const DEFAULT_DELIVERY: DeliveryTarget = {
    channel: 'telegram',
    peer: { id: '5257796557', type: 'user' },
};

interface FireRecord {
    id: string;
    name: string;
}

function makeStubExecutor(): { executor: JobExecutor; fires: FireRecord[] } {
    const fires: FireRecord[] = [];
    const stub = {
        async execute(job: { id: string; name: string }): Promise<ExecutionResult> {
            fires.push({ id: job.id, name: job.name });
            return { action: 'delivered', durationMs: 1 } as ExecutionResult;
        },
    };
    return {
        executor: stub as unknown as JobExecutor,
        fires,
    };
}

function makeJob(overrides: Partial<JobDefinition> = {}): JobDefinition {
    return {
        id: 'j',
        name: 'job',
        enabled: true,
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        payload: {
            deliveryMode: 'always',
            message: 'morning brief',
            oneshot: false,
        },
        requires: [],
        ...overrides,
    } as JobDefinition;
}

let tmpDir: string;
let store: StateStore;
let exec: ReturnType<typeof makeStubExecutor>;
let trigger: CronTrigger;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flopsy-cron-test-'));
    store = new StateStore(join(tmpDir, 'state.json'));
    exec = makeStubExecutor();
    trigger = new CronTrigger(exec.executor, store);
    trigger.resolveDelivery = () => DEFAULT_DELIVERY;
});

afterEach(async () => {
    await trigger.stop();
    store.stop();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
});

describe('CronTrigger.addJob / listJobs / removeJob', () => {
    it('addJob registers and listJobs surfaces it', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        await trigger.addJob(makeJob({ id: 'j1' }));
        const list = trigger.listJobs();
        expect(list.map((j) => j.id)).toContain('j1');
    });

    it('removeJob drops the entry', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        await trigger.addJob(makeJob({ id: 'j1' }));
        await trigger.removeJob('j1');
        expect(trigger.listJobs().find((j) => j.id === 'j1')).toBeUndefined();
    });

    it('removeJob on unknown id is a no-op', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        await expect(trigger.removeJob('nope')).resolves.toBeUndefined();
    });

    it('disabled jobs added at start are NOT registered', async () => {
        await trigger.start([makeJob({ id: 'off', enabled: false })], DEFAULT_DELIVERY);
        expect(trigger.listJobs().find((j) => j.id === 'off')).toBeUndefined();
    });
});

describe('CronTrigger.triggerNow', () => {
    it('returns false on unknown id', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        expect(await trigger.triggerNow('nope')).toBe(false);
    });

    it('fires the executor when the job is registered', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        await trigger.addJob(makeJob({ id: 'fire-me', name: 'morning' }));
        const ok = await trigger.triggerNow('fire-me');
        expect(ok).toBe(true);
        expect(exec.fires).toHaveLength(1);
        expect(exec.fires[0]!.id).toBe('fire-me');
    });
});

describe('CronTrigger.start — oneshot completion guard', () => {
    it('skips at-jobs whose oneshot completion was already persisted', async () => {
        store.markOneshotCompleted('j-completed');
        await trigger.start(
            [makeJob({
                id: 'j-completed',
                schedule: { kind: 'at', atMs: Date.now() + 60_000 },
                payload: { deliveryMode: 'always', oneshot: true, message: 'x' },
            })],
            DEFAULT_DELIVERY,
        );
        expect(trigger.listJobs().find((j) => j.id === 'j-completed')).toBeUndefined();
    });

    it('skips cron-kind oneshot jobs that already completed', async () => {
        store.markOneshotCompleted('cron-once');
        await trigger.start(
            [makeJob({
                id: 'cron-once',
                schedule: { kind: 'cron', expr: '0 9 * * *' },
                payload: { deliveryMode: 'always', oneshot: true, message: 'x' },
            })],
            DEFAULT_DELIVERY,
        );
        expect(trigger.listJobs().find((j) => j.id === 'cron-once')).toBeUndefined();
    });
});

describe('CronTrigger.start — past-due `at` handling', () => {
    it('past-due at-job within 2-minute grace fires immediately', async () => {
        const pastDueMs = Date.now() - 30_000; // 30s late, within grace
        await trigger.start(
            [makeJob({
                id: 'late-fire',
                schedule: { kind: 'at', atMs: pastDueMs },
                payload: { deliveryMode: 'always', oneshot: true, message: 'late' },
            })],
            DEFAULT_DELIVERY,
        );
        expect(exec.fires.find((f) => f.id === 'late-fire')).toBeDefined();
        // After firing, the row is dropped from the active jobs map.
        expect(trigger.listJobs().find((j) => j.id === 'late-fire')).toBeUndefined();
    });

    it('past-due at-job beyond grace is silently marked complete (no fire)', async () => {
        const pastDueMs = Date.now() - 5 * 60_000; // 5 min late, well beyond grace
        await trigger.start(
            [makeJob({
                id: 'too-late',
                schedule: { kind: 'at', atMs: pastDueMs },
                payload: { deliveryMode: 'always', oneshot: true, message: 'x' },
            })],
            DEFAULT_DELIVERY,
        );
        expect(exec.fires).toHaveLength(0);
        expect(trigger.listJobs().find((j) => j.id === 'too-late')).toBeUndefined();
        expect(store.isOneshotCompleted('too-late')).toBe(true);
    });

    it('calls deleteRuntimeRow when an at-job past-due is cleaned up', async () => {
        const deletedIds: string[] = [];
        trigger.deleteRuntimeRow = (id) => deletedIds.push(id);
        await trigger.start(
            [makeJob({
                id: 'cleanup-me',
                schedule: { kind: 'at', atMs: Date.now() - 5 * 60_000 },
                payload: { deliveryMode: 'always', oneshot: true, message: 'x' },
            })],
            DEFAULT_DELIVERY,
        );
        expect(deletedIds).toContain('cleanup-me');
    });
});

describe('CronTrigger.stop', () => {
    it('clears timers and registry', async () => {
        await trigger.start([], DEFAULT_DELIVERY);
        await trigger.addJob(makeJob({ id: 'a' }));
        await trigger.addJob(makeJob({ id: 'b' }));
        await trigger.stop();
        expect(trigger.listJobs()).toHaveLength(0);
        // After stop, triggerNow finds nothing.
        expect(await trigger.triggerNow('a')).toBe(false);
    });
});
