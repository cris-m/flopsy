/**
 * State + dedup store contracts that proactive depends on.
 *
 * The garbage deliveries we saw in proactive.json (recentDeliveries[]) all
 * went through these two stores. Critical regressions to guard against:
 *   - StateStore must clear stale isExecuting flags on boot, otherwise a
 *     SIGKILL during a fire permanently jams that schedule.
 *   - DedupStore.findSimilar must respect the time window so a delivery
 *     from yesterday doesn't suppress a fresh one today.
 *   - Runtime schedules persist across restarts (this is what survived
 *     the OOM and is still the source of the 5 active schedules).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/proactive/state/store';
import { ProactiveDedupStore } from '../src/proactive/state/dedup-store';

describe('StateStore — proactive.json roundtrip', () => {
    let dir: string;
    let path: string;
    let store: StateStore;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'flopsy-state-'));
        path = join(dir, 'proactive.json');
        store = new StateStore(path);
    });
    afterEach(() => {
        store.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    it('starts with empty job state', async () => {
        const js = await store.getJobState('never-fired');
        expect(js.runCount).toBe(0);
        expect(js.deliveredCount).toBe(0);
        expect(js.isExecuting).toBeUndefined();
    });

    it('persists job state and reloads it', async () => {
        await store.setJobState('j1', {
            runCount: 5,
            deliveredCount: 2,
            suppressedCount: 3,
            queuedCount: 0,
            consecutiveErrors: 0,
            lastStatus: 'success',
        });
        // flush() is on a 10s timer — force a stop() to write synchronously.
        store.stop();

        const reopen = new StateStore(path);
        const reloaded = await reopen.getJobState('j1');
        expect(reloaded.runCount).toBe(5);
        expect(reloaded.deliveredCount).toBe(2);
        expect(reloaded.lastStatus).toBe('success');
        reopen.stop();
    });

    it('clears stale isExecuting flags on boot (SIGKILL recovery)', async () => {
        // Simulate a SIGKILL during fire: state.json says isExecuting=true.
        const stuckState = {
            version: 1,
            presence: { lastMessageAt: 0, activityWindow: 'away' },
            jobs: {
                stuck: {
                    runCount: 1,
                    deliveredCount: 0,
                    suppressedCount: 0,
                    queuedCount: 0,
                    consecutiveErrors: 0,
                    isExecuting: true,
                },
            },
            reportedItems: { emails: [], meetings: [], tasks: [], news: [] },
            recentDeliveries: [],
            recentTopics: [],
        };
        store.stop();
        writeFileSync(path, JSON.stringify(stuckState), 'utf8');

        const reopen = new StateStore(path);
        const js = await reopen.getJobState('stuck');
        expect(js.isExecuting).toBe(false);
        reopen.stop();
    });

    it('caps recentDeliveries at the configured maximum', async () => {
        for (let i = 0; i < 60; i++) {
            await store.addDelivery(`message ${i}`, 'src');
        }
        expect(store.getRecentDeliveries().length).toBeLessThanOrEqual(50);
        // Newest first.
        expect(store.getRecentDeliveries()[0]!.content).toBe('message 59');
    });

    it('truncates delivery content to 500 chars', async () => {
        const long = 'x'.repeat(2000);
        await store.addDelivery(long, 'src');
        expect(store.getRecentDeliveries()[0]!.content.length).toBe(500);
    });

    it('tracks oneshot completion and prevents re-fire', () => {
        expect(store.isOneshotCompleted('one')).toBe(false);
        store.markOneshotCompleted('one');
        expect(store.isOneshotCompleted('one')).toBe(true);

        // Idempotent.
        store.markOneshotCompleted('one');
        store.stop();
        const reopen = new StateStore(path);
        expect(reopen.isOneshotCompleted('one')).toBe(true);
        reopen.stop();
    });

    it('deletes job state on schedule removal (no orphan ghosts)', async () => {
        await store.setJobState('to-remove', {
            runCount: 1,
            deliveredCount: 0,
            suppressedCount: 0,
            queuedCount: 0,
            consecutiveErrors: 0,
        });
        expect(store.deleteJobState('to-remove')).toBe(true);
        expect(store.deleteJobState('to-remove')).toBe(false);
    });

    it('falls back to defaults when proactive.json is corrupt', () => {
        store.stop();
        writeFileSync(path, '{"this": is not valid', 'utf8');
        const reopen = new StateStore(path);
        // Should boot rather than throw — the loader logs a warn and resets.
        expect(reopen.getRecentDeliveries()).toEqual([]);
        reopen.stop();
    });

    it('respects version mismatch and resets to defaults', () => {
        store.stop();
        writeFileSync(
            path,
            JSON.stringify({ version: 999, jobs: { x: { runCount: 99 } } }),
            'utf8',
        );
        const reopen = new StateStore(path);
        // Old data must NOT be silently loaded under the new schema.
        const js = reopen.getJobStateSync('x');
        expect(js).toBeNull();
        reopen.stop();
    });
});

describe('ProactiveDedupStore — runtime schedules + delivery dedup', () => {
    let dir: string;
    let dbPath: string;
    let store: ProactiveDedupStore;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'flopsy-dedup-'));
        dbPath = join(dir, 'proactive.db');
        store = new ProactiveDedupStore(dbPath);
    });
    afterEach(() => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('persists runtime schedules across reopen', () => {
        store.insertRuntimeSchedule({
            id: 'cron-x',
            kind: 'cron',
            config: { schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'Asia/Tokyo' } },
            createdByAgent: 'gandalf',
        });

        store.close();
        const reopen = new ProactiveDedupStore(dbPath);
        const rows = reopen.listRuntimeSchedules();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe('cron-x');
        expect(rows[0]!.kind).toBe('cron');

        const config = JSON.parse(rows[0]!.configJson);
        expect(config.schedule.tz).toBe('Asia/Tokyo'); // tz survives roundtrip
        reopen.close();
    });

    it('updates runtime schedule config in place (preserves enabled flag)', () => {
        store.insertRuntimeSchedule({
            id: 'cron-x',
            kind: 'cron',
            config: { schedule: { kind: 'cron', expr: '0 7 * * *' } },
            enabled: true,
        });
        store.setRuntimeScheduleEnabled('cron-x', false);

        const ok = store.updateRuntimeScheduleConfig('cron-x', {
            schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'Asia/Tokyo' },
        });
        expect(ok).toBe(true);

        const row = store.getRuntimeSchedule('cron-x');
        expect(row).not.toBeNull();
        expect(row!.enabled).toBe(false); // preserved
        expect(JSON.parse(row!.configJson).schedule.tz).toBe('Asia/Tokyo');
    });

    it('deletes runtime schedules and reports change', () => {
        store.insertRuntimeSchedule({
            id: 'rm-me',
            kind: 'heartbeat',
            config: { name: 'pulse', interval: '30m' },
        });
        expect(store.deleteRuntimeSchedule('rm-me')).toBe(true);
        expect(store.deleteRuntimeSchedule('rm-me')).toBe(false);
    });

    it('records a delivery row and counts it in countDeliveriesSince', () => {
        store.recordDelivery('proactive-smart-pulse', 'pulse content');
        const out = store.countDeliveriesSince(0);
        expect(out.total).toBe(1);
        expect(out.bySource['proactive-smart-pulse']).toBe(1);
    });

    it('truncates recorded delivery content to 4000 chars', () => {
        const huge = 'a'.repeat(10_000);
        store.recordDelivery('s', huge);
        const list = store.listDeliveriesBySource('s', 1);
        expect(list[0]!.content.length).toBe(4000);
    });

    it('findSimilar matches identical embeddings within window', () => {
        const vec = [1, 0, 0];
        store.recordDelivery('a', 'duplicate body', vec);
        const match = store.findSimilar(vec, 0.9, 60_000);
        expect(match).not.toBeNull();
        expect(match!.similarity).toBeCloseTo(1.0);
    });

    it('findSimilar respects the time window cutoff', async () => {
        const vec = [1, 0, 0];
        // Insert with the natural now() timestamp first.
        store.recordDelivery('a', 'old', vec);

        // Tiny window — 1 ms — sleep past it. The just-recorded delivery should
        // fall outside the cutoff. Sleep a bit so monotonic time advances.
        await new Promise((r) => setTimeout(r, 50));
        const match = store.findSimilar(vec, 0.9, 1);
        expect(match).toBeNull();
    });

    it('marks reported IDs and lists them newest-first', () => {
        store.markReported('news', ['https://a.com', 'https://b.com'], 'src1');
        store.markReported('news', ['https://c.com'], 'src2');

        expect(store.isReported('news', 'https://a.com')).toBe(true);
        expect(store.isReported('news', 'https://nope.com')).toBe(false);

        const recent = store.listReported('news', 10);
        expect(recent).toContain('https://a.com');
        expect(recent).toContain('https://c.com');
    });

    it('prunes old delivery + reported rows past max age', () => {
        store.recordDelivery('a', 'old');
        store.markReported('news', ['x'], 'src');

        // Use a 0-ms maxAge → everything is "old". Sleep first so the cutoff
        // is strictly in the future of the record's delivered_at.
        return new Promise<void>((resolve) => {
            setTimeout(() => {
                const result = store.prune(0, 0);
                expect(result.deliveries).toBeGreaterThanOrEqual(1);
                expect(result.reported).toBeGreaterThanOrEqual(1);
                resolve();
            }, 30);
        });
    });
});

describe('proactive.json + proactive.db — production-shaped fixture', () => {
    let dir: string;
    let stateFile: string;
    let dbFile: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'flopsy-prod-shape-'));
        stateFile = join(dir, 'proactive.json');
        dbFile = join(dir, 'proactive.db');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('reproduces the prod shape: 5 schedules + 1 garbage delivery, both readable', () => {
        // Mirror the production proactive.db that the audit pulled.
        const db = new ProactiveDedupStore(dbFile);
        const schedules = [
            {
                id: 'proactive-morning-briefing',
                kind: 'cron' as const,
                config: {
                    schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'Asia/Tokyo' },
                    payload: { promptFile: 'proactive-morning-briefing-morning-briefing.md' },
                },
            },
            {
                id: 'proactive-evening-recap',
                kind: 'cron' as const,
                config: {
                    schedule: { kind: 'cron', expr: '0 21 * * *', tz: 'Asia/Tokyo' },
                    payload: { promptFile: 'proactive-evening-recap-evening-recap.md' },
                },
            },
            {
                id: 'proactive-night-reflection',
                kind: 'cron' as const,
                config: {
                    schedule: { kind: 'cron', expr: '30 23 * * *', tz: 'Asia/Tokyo' },
                    payload: { promptFile: 'proactive-night-reflection-night-reflection.md' },
                },
            },
            {
                id: 'proactive-weekly-review',
                kind: 'cron' as const,
                config: {
                    schedule: { kind: 'cron', expr: '0 17 * * 0', tz: 'Asia/Tokyo' },
                    payload: { promptFile: 'proactive-weekly-review-weekly-review.md' },
                },
            },
            {
                id: 'proactive-smart-pulse',
                kind: 'heartbeat' as const,
                config: {
                    interval: '30m',
                    promptFile: 'proactive-smart-pulse-smart-pulse.md',
                },
            },
        ];
        for (const s of schedules) db.insertRuntimeSchedule(s);

        // The garbage delivery that triggered this whole investigation.
        db.recordDelivery(
            'proactive-smart-pulse',
            'The main goal is to achieve the best assistance.',
        );

        const rows = db.listRuntimeSchedules();
        expect(rows).toHaveLength(5);
        expect(rows.find((r) => r.id === 'proactive-smart-pulse')!.kind).toBe('heartbeat');
        expect(
            rows.filter((r) => r.kind === 'cron').every((r) => {
                const c = JSON.parse(r.configJson);
                return c.schedule.tz === 'Asia/Tokyo';
            }),
        ).toBe(true);

        const deliveries = db.listDeliveriesBySource('proactive-smart-pulse', 5);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]!.content).toMatch(/best assistance/);
        db.close();

        // And mirror proactive.json's shape.
        const ss = new StateStore(stateFile);
        // Recreate jobs[] for each schedule with the suppressed/error counters
        // we observed in production.
        ss.setJobState('proactive-smart-pulse', {
            runCount: 19,
            deliveredCount: 3,
            suppressedCount: 15,
            queuedCount: 0,
            consecutiveErrors: 0,
            lastStatus: 'success',
            lastAction: 'suppressed',
        });
        ss.stop();

        const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
        expect(raw.jobs['proactive-smart-pulse'].runCount).toBe(19);
        expect(raw.jobs['proactive-smart-pulse'].deliveredCount).toBe(3);
    });
});
