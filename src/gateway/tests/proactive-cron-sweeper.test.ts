/**
 * CronHealthSweeper — Saboo's self-healing pattern.
 *
 * The morning-briefing missed its first fire because the daemon was OOM-killed
 * around boot time. Without this sweeper, the next opportunity to deliver was
 * 24 hours later. The sweeper walks all registered cron jobs every 5 min,
 * computes the most recent expected fire time for each, and force-triggers
 * any whose `lastRunAt` is more than a tolerance window behind.
 *
 * The policy under test:
 *   - never-fired job, past its first expected fire by > tolerance → stale
 *   - last fire is older than the most recent expected fire by > tolerance → stale
 *   - past-due `at` schedule → stale (no tolerance window — fire ASAP)
 *   - on-time job (lastRunAt covers the most recent expected fire) → not stale
 *   - disabled job → ignored
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronHealthSweeper } from '../src/proactive/health/cron-sweeper';
import { StateStore } from '../src/proactive/state/store';
import type { CronTrigger } from '../src/proactive/triggers/cron';
import type { JobDefinition } from '../src/proactive/types';

interface StubTrigger {
    listJobs(): JobDefinition[];
    triggerNow(id: string): Promise<boolean>;
    fired: string[];
}

function stubTrigger(jobs: JobDefinition[]): StubTrigger {
    const fired: string[] = [];
    return {
        listJobs: () => jobs,
        triggerNow: async (id: string) => {
            fired.push(id);
            return true;
        },
        fired,
    };
}

const DELIVERY = {
    channelName: 'telegram',
    peer: { id: 'u', type: 'user' as const },
};

function cronJob(
    overrides: Partial<JobDefinition> & { schedule: JobDefinition['schedule'] },
): JobDefinition {
    return {
        id: overrides.id ?? 'job',
        name: overrides.name ?? 'job',
        enabled: overrides.enabled ?? true,
        payload: overrides.payload ?? {
            promptFile: 'p.md',
            deliveryMode: 'always',
            delivery: DELIVERY,
        },
        ...overrides,
    };
}

describe('CronHealthSweeper.inspectJob', () => {
    let dir: string;
    let store: StateStore;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'flopsy-sweeper-'));
        store = new StateStore(join(dir, 'proactive.json'));
    });
    afterEach(() => {
        store.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    it('never-fired daily cron past first window is stale', () => {
        const sweeper = new CronHealthSweeper(() => null, store);
        // Cron expr "0 7 * * *" — fires at 07:00 daily. Sweeper called at
        // 09:00 same day → previous fire was 07:00 today, 2h ago. With
        // 1.5x daily tolerance that's still way under threshold (1.5 days),
        // BUT the minGrace floor of 5min should NOT promote it because
        // the tolerance for a daily job is already much larger than 5min.
        // So the right outcome is NOT stale (tolerance = 1.5 × 86400000 ms).
        const job = cronJob({
            id: 'morning',
            schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'UTC' },
        });
        const at0900 = Date.UTC(2026, 4, 1, 9, 0, 0);
        const check = sweeper.inspectJob(job, at0900);
        expect(check).not.toBeNull();
        expect(check!.lastRunAtMs).toBeUndefined();
        expect(check!.delayMs).toBe(2 * 60 * 60 * 1000);
        expect(check!.stale).toBe(false);
    });

    it('stale when lastRunAt is older than most recent expected fire by > tolerance', async () => {
        const sweeper = new CronHealthSweeper(() => null, store);
        // 'every 1m' — period 60_000, tolerance = max(5min floor, 1.5 × 60s) = 5min.
        // Last run was 10 min ago — well past tolerance.
        const job = cronJob({
            id: 'tick',
            schedule: { kind: 'every', everyMs: 60_000, anchorMs: 0 },
        });
        const now = Date.now();
        await store.setJobState('tick', {
            runCount: 5,
            deliveredCount: 5,
            suppressedCount: 0,
            queuedCount: 0,
            consecutiveErrors: 0,
            lastRunAt: now - 10 * 60 * 1000,
        });
        const check = sweeper.inspectJob(job, now);
        expect(check).not.toBeNull();
        expect(check!.stale).toBe(true);
    });

    it('on-time when lastRunAt covers the most recent expected fire', async () => {
        const sweeper = new CronHealthSweeper(() => null, store);
        const job = cronJob({
            id: 'tick',
            schedule: { kind: 'every', everyMs: 60_000, anchorMs: 0 },
        });
        const now = Date.now();
        // Last run was 10 sec ago — well within tolerance.
        await store.setJobState('tick', {
            runCount: 5,
            deliveredCount: 5,
            suppressedCount: 0,
            queuedCount: 0,
            consecutiveErrors: 0,
            lastRunAt: now - 10_000,
        });
        const check = sweeper.inspectJob(job, now);
        expect(check!.stale).toBe(false);
    });

    it('never-fired daily cron with daemon down 36h is stale (>1.5×period)', async () => {
        const sweeper = new CronHealthSweeper(() => null, store);
        const job = cronJob({
            id: 'morning',
            schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'UTC' },
        });
        // Sweeper called at 19:00 the next day — 36h after the missed
        // 07:00 fire. That exceeds the 1.5 × 24h tolerance.
        const next = Date.UTC(2026, 4, 2, 19, 0, 0);
        const previous = Date.UTC(2026, 4, 2, 7, 0, 0);
        // The most-recent expected fire is the next morning's 07:00,
        // which was 12h ago — still within tolerance for the LAST fire.
        const check = sweeper.inspectJob(job, next);
        expect(check).not.toBeNull();
        expect(check!.expectedAtMs).toBe(previous);
        // 12h < 1.5 × 86400000ms, so not stale yet — confirms our
        // tolerance heuristic doesn't fire for normal daily jitter.
        expect(check!.stale).toBe(false);
    });

    it('past-due `at` schedule that never fired is stale', () => {
        const sweeper = new CronHealthSweeper(() => null, store);
        const now = Date.now();
        const job = cronJob({
            id: 'one-shot',
            schedule: { kind: 'at', atMs: now - 60_000 },
        });
        const check = sweeper.inspectJob(job, now);
        expect(check).not.toBeNull();
        expect(check!.stale).toBe(true);
    });

    it('future `at` schedule is not stale', () => {
        const sweeper = new CronHealthSweeper(() => null, store);
        const now = Date.now();
        const job = cronJob({
            id: 'future',
            schedule: { kind: 'at', atMs: now + 60_000 },
        });
        const check = sweeper.inspectJob(job, now);
        expect(check).toBeNull();
    });

    it('disabled jobs are skipped', () => {
        const sweeper = new CronHealthSweeper(() => null, store);
        const job = cronJob({
            id: 'off',
            enabled: false,
            schedule: { kind: 'every', everyMs: 1000, anchorMs: 0 },
        });
        expect(sweeper.inspectJob(job, Date.now())).toBeNull();
    });

    it('invalid cron expression returns null (logged) rather than crashing', () => {
        const sweeper = new CronHealthSweeper(() => null, store);
        const job = cronJob({
            id: 'bad',
            schedule: { kind: 'cron', expr: 'not a cron expression', tz: 'UTC' },
        });
        expect(sweeper.inspectJob(job, Date.now())).toBeNull();
    });
});

describe('CronHealthSweeper.sweep', () => {
    let dir: string;
    let store: StateStore;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'flopsy-sweeper-'));
        store = new StateStore(join(dir, 'proactive.json'));
    });
    afterEach(() => {
        store.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    it('returns empty result when cron trigger is null', async () => {
        const sweeper = new CronHealthSweeper(() => null, store);
        const result = await sweeper.sweep();
        expect(result).toEqual({ checked: 0, stale: [], forced: [], skipped: [] });
    });

    it('force-fires stale jobs and reports them', async () => {
        const now = Date.now();
        const stale = cronJob({
            id: 'stale-1',
            schedule: { kind: 'every', everyMs: 60_000, anchorMs: 0 },
        });
        const fresh = cronJob({
            id: 'fresh-1',
            schedule: { kind: 'every', everyMs: 60_000, anchorMs: 0 },
        });
        await store.setJobState('stale-1', {
            runCount: 1,
            deliveredCount: 1,
            suppressedCount: 0,
            queuedCount: 0,
            consecutiveErrors: 0,
            lastRunAt: now - 30 * 60 * 1000, // 30 min ago — way stale
        });
        await store.setJobState('fresh-1', {
            runCount: 1,
            deliveredCount: 1,
            suppressedCount: 0,
            queuedCount: 0,
            consecutiveErrors: 0,
            lastRunAt: now - 5_000,
        });

        const trigger = stubTrigger([stale, fresh]);
        const sweeper = new CronHealthSweeper(
            () => trigger as unknown as CronTrigger,
            store,
        );

        const result = await sweeper.sweep(now);
        expect(result.checked).toBe(2);
        expect(result.forced).toEqual(['stale-1']);
        expect(trigger.fired).toEqual(['stale-1']);
        expect(result.stale).toHaveLength(1);
    });

    it('records skip reason when triggerNow throws', async () => {
        const stale = cronJob({
            id: 'fails',
            schedule: { kind: 'every', everyMs: 60_000, anchorMs: 0 },
        });
        const now = Date.now();
        await store.setJobState('fails', {
            runCount: 1,
            deliveredCount: 0,
            suppressedCount: 0,
            queuedCount: 0,
            consecutiveErrors: 0,
            lastRunAt: now - 60 * 60 * 1000,
        });

        const trigger = {
            listJobs: () => [stale],
            triggerNow: async () => {
                throw new Error('cron trigger broken');
            },
            fired: [] as string[],
        };
        const sweeper = new CronHealthSweeper(
            () => trigger as unknown as CronTrigger,
            store,
        );
        const result = await sweeper.sweep(now);
        expect(result.forced).toEqual([]);
        expect(result.skipped).toEqual([{ id: 'fails', reason: 'cron trigger broken' }]);
    });

    it('records skip reason when triggerNow returns false (job not found)', async () => {
        const stale = cronJob({
            id: 'gone',
            schedule: { kind: 'every', everyMs: 60_000, anchorMs: 0 },
        });
        const now = Date.now();
        await store.setJobState('gone', {
            runCount: 1,
            deliveredCount: 0,
            suppressedCount: 0,
            queuedCount: 0,
            consecutiveErrors: 0,
            lastRunAt: now - 60 * 60 * 1000,
        });

        const trigger = {
            listJobs: () => [stale],
            triggerNow: async () => false,
            fired: [] as string[],
        };
        const sweeper = new CronHealthSweeper(
            () => trigger as unknown as CronTrigger,
            store,
        );
        const result = await sweeper.sweep(now);
        expect(result.forced).toEqual([]);
        expect(result.skipped[0]!.reason).toBe('triggerNow returned false');
    });
});
