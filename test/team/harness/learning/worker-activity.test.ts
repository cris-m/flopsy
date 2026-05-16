import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LearningStore } from '@flopsy/team';

let tmpDir: string;
let store: LearningStore;
let originalHome: string | undefined;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flopsy-worker-activity-'));
    originalHome = process.env.FLOPSY_HOME;
    process.env.FLOPSY_HOME = tmpDir;
    store = new LearningStore(join(tmpDir, 'state.db'));
});

afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.FLOPSY_HOME;
    else process.env.FLOPSY_HOME = originalHome;
});

describe('recordDelegateRun + listWorkerActivity', () => {
    it('records a completed delegate run and surfaces it in activity', () => {
        const now = Date.now();
        store.recordDelegateRun({
            taskId: 'd-1',
            threadId: 'tg:dm:u1',
            workerName: 'legolas',
            taskPrompt: 'search HN',
            toolAllowlist: ['web_search'],
            startedAtMs: now - 1200,
            endedAtMs: now,
            status: 'completed',
            result: '5 posts found',
            error: null,
        });

        const rows = store.listWorkerActivity({ sinceMs: now - 60_000 });
        expect(rows).toHaveLength(1);
        const r = rows[0]!;
        expect(r.workerName).toBe('legolas');
        expect(r.delegateCalls).toBe(1);
        expect(r.spawnCalls).toBe(0);
        expect(r.completed).toBe(1);
        expect(r.failed).toBe(0);
        expect(r.successRate).toBe(1);
        expect(r.avgDurationMs).toBeGreaterThanOrEqual(1100);
        expect(r.avgDurationMs).toBeLessThanOrEqual(1300);
    });

    it('rolls up spawn + delegate side-by-side per worker', () => {
        const now = Date.now();
        store.recordDelegateRun({
            taskId: 'd-2', threadId: 't', workerName: 'gimli',
            taskPrompt: 'review', toolAllowlist: null,
            startedAtMs: now - 500, endedAtMs: now,
            status: 'completed', result: 'ok', error: null,
        });
        store.recordBackgroundTask({
            taskId: 'b-1', threadId: 't', workerName: 'gimli',
            taskPrompt: 'long brief', toolAllowlist: null,
            timeoutMs: 60_000, deliveryMode: null,
            status: 'running', createdAt: now - 100, endedAt: null,
            result: null, error: null, description: null, kind: 'spawn',
        });

        const rows = store.listWorkerActivity({ sinceMs: now - 60_000 });
        expect(rows).toHaveLength(1);
        const r = rows[0]!;
        expect(r.workerName).toBe('gimli');
        expect(r.delegateCalls).toBe(1);
        expect(r.spawnCalls).toBe(1);
        expect(r.totalCalls).toBe(2);
        expect(r.running).toBe(1);
        expect(r.completed).toBe(1);
        // running rows don't count toward success-rate denominator
        expect(r.successRate).toBe(1);
    });

    it('treats failed/killed correctly in successRate', () => {
        const now = Date.now();
        for (const status of ['completed', 'completed', 'failed', 'killed'] as const) {
            store.recordDelegateRun({
                taskId: `d-${status}-${Math.random()}`,
                threadId: 't',
                workerName: 'aragorn',
                taskPrompt: 'x',
                toolAllowlist: null,
                startedAtMs: now - 1000,
                endedAtMs: now,
                status,
                result: status === 'completed' ? 'ok' : null,
                error: status === 'completed' ? null : 'boom',
            });
        }
        const rows = store.listWorkerActivity({ sinceMs: now - 60_000 });
        expect(rows).toHaveLength(1);
        const r = rows[0]!;
        expect(r.completed).toBe(2);
        expect(r.failed).toBe(1);
        expect(r.killed).toBe(1);
        // 2 ok / (2 ok + 1 failed + 1 killed) = 0.5
        expect(r.successRate).toBe(0.5);
    });

    it('filters by sinceMs (older rows are excluded)', () => {
        const now = Date.now();
        store.recordDelegateRun({
            taskId: 'd-old', threadId: 't', workerName: 'sam',
            taskPrompt: 'x', toolAllowlist: null,
            startedAtMs: now - 7 * 24 * 3600_000,
            endedAtMs:   now - 7 * 24 * 3600_000 + 1000,
            status: 'completed', result: 'ok', error: null,
        });
        store.recordDelegateRun({
            taskId: 'd-new', threadId: 't', workerName: 'sam',
            taskPrompt: 'x', toolAllowlist: null,
            startedAtMs: now - 1000, endedAtMs: now,
            status: 'completed', result: 'ok', error: null,
        });
        const recent = store.listWorkerActivity({ sinceMs: now - 60_000 });
        expect(recent).toHaveLength(1);
        expect(recent[0]!.totalCalls).toBe(1);

        const wide = store.listWorkerActivity({ sinceMs: now - 30 * 24 * 3600_000 });
        expect(wide).toHaveLength(1);
        expect(wide[0]!.totalCalls).toBe(2);
    });

    it('filters by workerName when provided', () => {
        const now = Date.now();
        store.recordDelegateRun({
            taskId: 'd-l', threadId: 't', workerName: 'legolas',
            taskPrompt: 'x', toolAllowlist: null,
            startedAtMs: now - 500, endedAtMs: now,
            status: 'completed', result: 'ok', error: null,
        });
        store.recordDelegateRun({
            taskId: 'd-g', threadId: 't', workerName: 'gimli',
            taskPrompt: 'x', toolAllowlist: null,
            startedAtMs: now - 500, endedAtMs: now,
            status: 'completed', result: 'ok', error: null,
        });
        const onlyGimli = store.listWorkerActivity({
            sinceMs: now - 60_000,
            workerName: 'gimli',
        });
        expect(onlyGimli).toHaveLength(1);
        expect(onlyGimli[0]!.workerName).toBe('gimli');
    });
});
