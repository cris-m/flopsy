/**
 * ProactiveDedupStore — the storage layer behind the proactive engine.
 *
 * Covers:
 *   - Runtime schedules: insert, list, get, setEnabled, updateConfig (the
 *     `replaceRuntimeSchedule` engine path), delete.
 *   - Delivery history: recordDelivery, listDeliveriesBySource,
 *     countDeliveriesSince.
 *   - Anti-repetition: findSimilar (cosine-similarity), markReported,
 *     isReported, listReported.
 *   - Pruning: drops rows past the age cutoff.
 *
 * Uses an on-disk path inside a tmpdir because better-sqlite3's `:memory:`
 * mode trips the constructor's `mkdirSync(dirname(path))` on the path '.'.
 * Disk path also exercises the WAL setup the production store relies on.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProactiveDedupStore } from '@flopsy/gateway/proactive';

let tmpDir: string;
let store: ProactiveDedupStore;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flopsy-dedup-test-'));
    store = new ProactiveDedupStore(join(tmpDir, 'proactive.db'));
});

afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
});

describe('ProactiveDedupStore — runtime schedules', () => {
    it('inserts and lists a heartbeat schedule', () => {
        store.insertRuntimeSchedule({
            id: 'hb-1',
            kind: 'heartbeat',
            config: { name: 'inbox-check', interval: '30m', prompt: '...' },
        });
        const rows = store.listRuntimeSchedules();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe('hb-1');
        expect(rows[0]!.kind).toBe('heartbeat');
        expect(rows[0]!.enabled).toBe(true);
        expect(rows[0]!.createdAt).toBeGreaterThan(0);
    });

    it('round-trips a config object through JSON.stringify/parse', () => {
        const config = {
            id: 'cron-1',
            name: 'morning-brief',
            schedule: { kind: 'cron', expr: '0 9 * * *' },
            payload: { deliveryMode: 'always', message: 'good morning' },
        };
        store.insertRuntimeSchedule({ id: 'cron-1', kind: 'cron', config });
        const row = store.getRuntimeSchedule('cron-1');
        expect(row).not.toBeNull();
        expect(JSON.parse(row!.configJson)).toEqual(config);
    });

    it('listRuntimeSchedules orders newest-first', () => {
        store.insertRuntimeSchedule({ id: 'a', kind: 'heartbeat', config: {} });
        // Force a different created_at by sleeping the bare minimum SQLite ms tick.
        const second = Date.now() + 5;
        while (Date.now() <= second) { /* noop spin */ }
        store.insertRuntimeSchedule({ id: 'b', kind: 'heartbeat', config: {} });
        const rows = store.listRuntimeSchedules();
        expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    });

    it('persists createdBy provenance for runtime-created schedules', () => {
        store.insertRuntimeSchedule({
            id: 'hb-1',
            kind: 'heartbeat',
            config: {},
            createdByThread: 'telegram:dm:42',
            createdByAgent: 'gandalf',
        });
        const row = store.getRuntimeSchedule('hb-1');
        expect(row!.createdByThread).toBe('telegram:dm:42');
        expect(row!.createdByAgent).toBe('gandalf');
    });

    it('setRuntimeScheduleEnabled toggles the flag, returns false on unknown id', () => {
        store.insertRuntimeSchedule({ id: 'hb-1', kind: 'heartbeat', config: {} });
        expect(store.setRuntimeScheduleEnabled('hb-1', false)).toBe(true);
        expect(store.getRuntimeSchedule('hb-1')!.enabled).toBe(false);
        expect(store.setRuntimeScheduleEnabled('hb-1', true)).toBe(true);
        expect(store.getRuntimeSchedule('hb-1')!.enabled).toBe(true);
        expect(store.setRuntimeScheduleEnabled('does-not-exist', false)).toBe(false);
    });

    it('updateRuntimeScheduleConfig swaps config, preserves enabled', () => {
        store.insertRuntimeSchedule({
            id: 'hb-1',
            kind: 'heartbeat',
            config: { interval: '30m' },
            enabled: false,
        });
        const ok = store.updateRuntimeScheduleConfig('hb-1', { interval: '1h' });
        expect(ok).toBe(true);
        const row = store.getRuntimeSchedule('hb-1')!;
        expect(JSON.parse(row.configJson)).toEqual({ interval: '1h' });
        // Enabled flag should NOT have been clobbered by the config update.
        expect(row.enabled).toBe(false);
    });

    it('updateRuntimeScheduleConfig returns false when id is unknown', () => {
        expect(store.updateRuntimeScheduleConfig('nope', { x: 1 })).toBe(false);
    });

    it('deleteRuntimeSchedule removes the row, returns true on hit, false on miss', () => {
        store.insertRuntimeSchedule({ id: 'hb-1', kind: 'heartbeat', config: {} });
        expect(store.deleteRuntimeSchedule('hb-1')).toBe(true);
        expect(store.getRuntimeSchedule('hb-1')).toBeNull();
        expect(store.deleteRuntimeSchedule('hb-1')).toBe(false);
    });
});

describe('ProactiveDedupStore — delivery history', () => {
    it('recordDelivery + listDeliveriesBySource roundtrip', () => {
        store.recordDelivery('cron:morning', 'good morning! agenda for today: ...');
        store.recordDelivery('cron:morning', 'good morning! agenda for today: ...');
        store.recordDelivery('cron:other', 'hello');
        const rows = store.listDeliveriesBySource('cron:morning');
        expect(rows).toHaveLength(2);
        expect(rows[0]!.content).toMatch(/good morning/);
    });

    it('countDeliveriesSince groups by source', () => {
        const t0 = Date.now();
        store.recordDelivery('a', 'msg');
        store.recordDelivery('a', 'msg');
        store.recordDelivery('b', 'msg');
        const counts = store.countDeliveriesSince(t0 - 1000);
        expect(counts.total).toBe(3);
        expect(counts.bySource).toEqual({ a: 2, b: 1 });
    });
});

describe('ProactiveDedupStore — anti-repetition', () => {
    describe('findSimilar (cosine)', () => {
        it('returns null when no embeddings are recorded', () => {
            expect(store.findSimilar([1, 0, 0], 0.5, 60_000)).toBeNull();
        });

        it('finds a near-duplicate above threshold', () => {
            store.recordDelivery('s1', 'first message', [1, 0, 0]);
            const match = store.findSimilar([0.99, 0.05, 0], 0.9, 60_000);
            expect(match).not.toBeNull();
            expect(match!.source).toBe('s1');
            expect(match!.similarity).toBeGreaterThan(0.9);
        });

        it('rejects matches below threshold', () => {
            store.recordDelivery('s1', 'first message', [1, 0, 0]);
            const match = store.findSimilar([0, 1, 0], 0.5, 60_000);
            // Orthogonal vectors → cosine = 0 → no match at threshold 0.5.
            expect(match).toBeNull();
        });

        it('respects the time window (older deliveries are skipped)', () => {
            vi.useFakeTimers();
            try {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                store.recordDelivery('s1', 'old', [1, 0, 0]);
                // Advance 10s so the recorded row is now "10s old."
                vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
                const match = store.findSimilar([1, 0, 0], 0.9, 5_000);
                expect(match).toBeNull();
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('reported-id tracking', () => {
        it('markReported + isReported + listReported roundtrip', () => {
            const inserted = store.markReported('email', ['e1', 'e2', 'e3'], 'inbox-check');
            expect(inserted).toBe(3);
            expect(store.isReported('email', 'e1')).toBe(true);
            expect(store.isReported('email', 'eX')).toBe(false);
            const list = store.listReported('email');
            expect(list.sort()).toEqual(['e1', 'e2', 'e3']);
        });

        it('markReported is idempotent on duplicates within (type, item_id)', () => {
            store.markReported('news', ['n1'], 'src');
            store.markReported('news', ['n1'], 'src');
            expect(store.listReported('news')).toEqual(['n1']);
        });

        it('listReported scopes by type', () => {
            store.markReported('email', ['e1'], 'src');
            store.markReported('news', ['n1'], 'src');
            expect(store.listReported('email')).toEqual(['e1']);
            expect(store.listReported('news')).toEqual(['n1']);
        });
    });
});

describe('ProactiveDedupStore — pruning', () => {
    it('prune drops deliveries past deliveryMaxAgeMs and reported past reportedMaxAgeMs', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            store.recordDelivery('s', 'recent', [1, 0]);
            store.markReported('email', ['e1'], 's');
            // Advance 10s so the rows are demonstrably 10s old.
            vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
            const result = store.prune(5_000, 5_000);
            expect(result.deliveries).toBe(1);
            expect(result.reported).toBe(1);
            // Subsequent prune is a no-op (nothing left).
            expect(store.prune(5_000, 5_000)).toEqual({ deliveries: 0, reported: 0 });
        } finally {
            vi.useRealTimers();
        }
    });
});
