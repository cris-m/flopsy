/**
 * StateStore — JSON-backed proactive state (presence, jobs, deliveries,
 * reported items, oneshot completion, recent topics).
 *
 * Covers:
 *   - getJobState fallback to defaults / setJobState round-trip
 *   - deleteJobState removes orphans
 *   - addDelivery / addTopic respect their respective caps
 *   - addReportedItem dedups and caps per-type
 *   - oneshot completion: mark / isCompleted / clear
 *   - configSeeded marker
 *   - sync getJobStateSync for the hot status path
 *
 * Disk persistence is exercised implicitly: every mutate sets `dirty=true`
 * and the periodic flush writes JSON to the configured path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StateStore } from '@flopsy/gateway/proactive';

let tmpDir: string;
let store: StateStore;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flopsy-state-'));
    store = new StateStore(join(tmpDir, 'state.json'));
});

afterEach(() => {
    store.stop();
    rmSync(tmpDir, { recursive: true, force: true });
});

describe('StateStore — job state', () => {
    it('returns default JobState for unknown id (zero counters, no error)', async () => {
        const js = await store.getJobState('unknown');
        expect(js.runCount).toBe(0);
        expect(js.deliveredCount).toBe(0);
        expect(js.consecutiveErrors).toBe(0);
    });

    it('setJobState round-trips through getJobState', async () => {
        const next = {
            runCount: 5,
            deliveredCount: 3,
            suppressedCount: 1,
            queuedCount: 0,
            consecutiveErrors: 0,
            lastStatus: 'success' as const,
            lastRunAt: 1234567890,
        };
        await store.setJobState('job-1', next);
        const back = await store.getJobState('job-1');
        expect(back).toEqual(next);
    });

    it('getJobStateSync returns null before set, the row after', async () => {
        expect(store.getJobStateSync('j')).toBeNull();
        await store.setJobState('j', {
            runCount: 1, deliveredCount: 1, suppressedCount: 0,
            queuedCount: 0, consecutiveErrors: 0,
        });
        expect(store.getJobStateSync('j')!.runCount).toBe(1);
    });

    it('deleteJobState drops the row, returns true once / false on missing', async () => {
        await store.setJobState('j', {
            runCount: 1, deliveredCount: 0, suppressedCount: 0,
            queuedCount: 0, consecutiveErrors: 0,
        });
        expect(store.deleteJobState('j')).toBe(true);
        expect(store.getJobStateSync('j')).toBeNull();
        expect(store.deleteJobState('j')).toBe(false);
    });
});

describe('StateStore — recent deliveries', () => {
    it('addDelivery records newest-first', async () => {
        await store.addDelivery('first', 'src');
        await store.addDelivery('second', 'src');
        const list = store.getRecentDeliveries();
        expect(list[0]!.content).toBe('second');
        expect(list[1]!.content).toBe('first');
    });

    it('caps deliveries at 50 (oldest evicted)', async () => {
        for (let i = 0; i < 60; i++) {
            await store.addDelivery(`msg-${i}`, 'src');
        }
        const list = store.getRecentDeliveries();
        expect(list.length).toBeLessThanOrEqual(50);
        // Newest stays at index 0.
        expect(list[0]!.content).toBe('msg-59');
    });

    it('truncates very long content to 500 chars', async () => {
        const long = 'x'.repeat(2000);
        await store.addDelivery(long, 'src');
        expect(store.getRecentDeliveries()[0]!.content).toHaveLength(500);
    });
});

describe('StateStore — recent topics', () => {
    it('addTopic records topic + delivered flag, newest-first', async () => {
        await store.addTopic('weather', 'cron-morning', true);
        await store.addTopic('news', 'cron-morning', false);
        const list = store.getRecentTopics();
        expect(list[0]!.topic).toBe('news');
        expect(list[0]!.delivered).toBe(false);
        expect(list[1]!.topic).toBe('weather');
        expect(list[1]!.delivered).toBe(true);
    });

    it('caps topics at 100', async () => {
        for (let i = 0; i < 120; i++) {
            await store.addTopic(`t-${i}`, 'src', true);
        }
        expect(store.getRecentTopics().length).toBeLessThanOrEqual(100);
    });
});

describe('StateStore — reported items', () => {
    it('addReportedItem dedups within a type', async () => {
        await store.addReportedItem('emails', 'e1');
        await store.addReportedItem('emails', 'e1');
        expect(await store.isReported('emails', 'e1')).toBe(true);
    });

    it('isReported is type-scoped', async () => {
        await store.addReportedItem('emails', 'item-1');
        expect(await store.isReported('news', 'item-1')).toBe(false);
    });

    it('caps per-type at 500 (oldest evicted)', async () => {
        for (let i = 0; i < 600; i++) {
            await store.addReportedItem('emails', `id-${i}`);
        }
        // Oldest entries trimmed; the most recent should still be reachable.
        expect(await store.isReported('emails', 'id-599')).toBe(true);
        // Earliest should be evicted.
        expect(await store.isReported('emails', 'id-0')).toBe(false);
    });
});

describe('StateStore — oneshot completion', () => {
    it('isOneshotCompleted is false before mark, true after', () => {
        expect(store.isOneshotCompleted('once')).toBe(false);
        store.markOneshotCompleted('once');
        expect(store.isOneshotCompleted('once')).toBe(true);
    });

    it('markOneshotCompleted is idempotent', () => {
        store.markOneshotCompleted('once');
        store.markOneshotCompleted('once');
        expect(store.isOneshotCompleted('once')).toBe(true);
    });

    it('clearOneshotCompleted lets a key fire again', () => {
        store.markOneshotCompleted('once');
        expect(store.clearOneshotCompleted('once')).toBe(true);
        expect(store.isOneshotCompleted('once')).toBe(false);
        // Second clear is a no-op.
        expect(store.clearOneshotCompleted('once')).toBe(false);
    });
});

describe('StateStore — config seed marker', () => {
    it('getConfigSeededAt is null until markConfigSeeded fires', () => {
        expect(store.getConfigSeededAt()).toBeNull();
        const before = Date.now();
        store.markConfigSeeded();
        const after = store.getConfigSeededAt()!;
        expect(after).toBeGreaterThanOrEqual(before);
    });
});

describe('StateStore — persistence on stop', () => {
    it('flushes state to disk when stop() runs', async () => {
        await store.setJobState('j', {
            runCount: 7, deliveredCount: 7, suppressedCount: 0,
            queuedCount: 0, consecutiveErrors: 0,
        });
        store.stop();
        const path = join(tmpDir, 'state.json');
        expect(existsSync(path)).toBe(true);
        const persisted = JSON.parse(readFileSync(path, 'utf-8'));
        expect(persisted.jobs.j.runCount).toBe(7);
        // Construct a NEW store from the same file — should hydrate.
        store = new StateStore(path);
        expect(store.getJobStateSync('j')!.runCount).toBe(7);
    });
});
