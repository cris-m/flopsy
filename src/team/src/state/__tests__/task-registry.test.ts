import { describe, it, expect } from 'vitest';
import {
    createBackgroundJobTask,
    createTeammateTask,
    isTeammateTask,
    toIdle,
    toRunning,
    toTerminal,
} from '../task-state';
import { TaskRegistry } from '../task-registry';

describe('TaskRegistry / crud', () => {
    it('registers and retrieves', () => {
        const r = new TaskRegistry();
        const t = createTeammateTask({ workerName: 'legolas', description: 'x', depth: 0 });
        r.register(t);
        expect(r.get(t.id)).toEqual(t);
        expect(r.has(t.id)).toBe(true);
        expect(r.size()).toBe(1);
    });

    it('rejects duplicate IDs', () => {
        const r = new TaskRegistry();
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        r.register(t);
        expect(() => r.register(t)).toThrow(/duplicate/);
    });

    it('replace updates an existing task', () => {
        const r = new TaskRegistry();
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        r.register(t);
        const running = toRunning(t);
        if (!running.ok) throw new Error('setup');
        expect(r.replace(running.task)).toBe(true);
        expect(r.get(t.id)?.status).toBe('running');
    });

    it('replace returns false for unknown id', () => {
        const r = new TaskRegistry();
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        expect(r.replace(t)).toBe(false);
    });

    it('patch runs updater and writes back', () => {
        const r = new TaskRegistry();
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        r.register(t);
        const ok = r.patch(t.id, (curr: typeof t) => ({ ...curr, toolUseCount: 5 }));
        expect(ok).toBe(true);
        const after = r.get(t.id);
        if (after && isTeammateTask(after)) expect(after.toolUseCount).toBe(5);
    });

    it('remove deletes', () => {
        const r = new TaskRegistry();
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        r.register(t);
        expect(r.remove(t.id)).toBe(true);
        expect(r.has(t.id)).toBe(false);
        expect(r.remove(t.id)).toBe(false);
    });
});

describe('TaskRegistry / queries', () => {
    it('listActive excludes terminal tasks', () => {
        const r = new TaskRegistry();
        const a = createTeammateTask({ workerName: 'a', description: '', depth: 0 });
        const b = createTeammateTask({ workerName: 'b', description: '', depth: 0 });
        r.register(a);
        r.register(b);
        const doneB = toTerminal(b, 'completed');
        if (doneB.ok) r.replace(doneB.task);

        const active = r.listActive();
        expect(active.map(t => t.id)).toEqual([a.id]);
    });

    it('listByType and listByStatus filter correctly', () => {
        const r = new TaskRegistry();
        const team = createTeammateTask({ workerName: 'x', description: '', depth: 0 });
        const job = createBackgroundJobTask({ prompt: 'y', description: '', depth: 0 });
        r.register(team);
        r.register(job);

        expect(r.listByType('teammate').map(t => t.id)).toEqual([team.id]);
        expect(r.listByType('background_job').map(t => t.id)).toEqual([job.id]);
        expect(r.listByStatus('pending')).toHaveLength(2);
    });

    it('findActiveTeammate returns the non-terminal teammate by worker', () => {
        const r = new TaskRegistry();
        const first = createTeammateTask({
            workerName: 'legolas',
            description: 'old',
            depth: 0,
        });
        r.register(first);
        const done = toTerminal(first, 'completed');
        if (done.ok) r.replace(done.task);

        const second = createTeammateTask({
            workerName: 'legolas',
            description: 'fresh',
            depth: 0,
        });
        r.register(second);

        const found = r.findActiveTeammate('legolas');
        expect(found?.id).toBe(second.id);
    });

    it('findActiveTeammate returns undefined when none active', () => {
        const r = new TaskRegistry();
        const t = createTeammateTask({ workerName: 'gimli', description: '', depth: 0 });
        r.register(t);
        const killed = toTerminal(t, 'killed');
        if (killed.ok) r.replace(killed.task);
        expect(r.findActiveTeammate('gimli')).toBeUndefined();
    });

    it('snapshot counts by status and type', () => {
        const r = new TaskRegistry();
        r.register(createTeammateTask({ workerName: 'a', description: '', depth: 0 }));
        r.register(createTeammateTask({ workerName: 'b', description: '', depth: 0 }));
        r.register(createBackgroundJobTask({ prompt: '', description: '', depth: 0 }));

        const s = r.snapshot();
        expect(s.total).toBe(3);
        expect(s.byStatus.pending).toBe(3);
        expect(s.byType.teammate).toBe(2);
        expect(s.byType.background_job).toBe(1);
    });
});

describe('TaskRegistry / pendingMessages', () => {
    it('pushPending appends to teammate', () => {
        const r = new TaskRegistry();
        const t = createTeammateTask({ workerName: 'x', description: '', depth: 0 });
        r.register(t);
        expect(r.pushPending(t.id, 'hi')).toBe(true);
        expect(r.pushPending(t.id, 'there')).toBe(true);
        const after = r.get(t.id);
        if (after && isTeammateTask(after)) {
            expect(after.pendingMessages).toEqual(['hi', 'there']);
        }
    });

    it('pushPending rejects non-teammate tasks', () => {
        const r = new TaskRegistry();
        const job = createBackgroundJobTask({ prompt: '', description: '', depth: 0 });
        r.register(job);
        expect(r.pushPending(job.id, 'hi')).toBe(false);
    });

    it('pushPending rejects unknown ids', () => {
        const r = new TaskRegistry();
        expect(r.pushPending('t_none', 'hi')).toBe(false);
    });

    it('pushPending rejects terminal tasks', () => {
        const r = new TaskRegistry();
        const t = createTeammateTask({ workerName: 'x', description: '', depth: 0 });
        r.register(t);
        const done = toTerminal(t, 'completed');
        if (done.ok) r.replace(done.task);
        expect(r.pushPending(t.id, 'hi')).toBe(false);
    });

    it('drainPending returns and clears', () => {
        const r = new TaskRegistry();
        const t = createTeammateTask({ workerName: 'x', description: '', depth: 0 });
        r.register(t);
        r.pushPending(t.id, 'one');
        r.pushPending(t.id, 'two');
        expect(r.drainPending(t.id)).toEqual(['one', 'two']);
        expect(r.drainPending(t.id)).toEqual([]);
        const after = r.get(t.id);
        if (after && isTeammateTask(after)) expect(after.pendingMessages).toEqual([]);
    });

    it('drainPending on unknown id returns []', () => {
        const r = new TaskRegistry();
        expect(r.drainPending('t_nope')).toEqual([]);
    });

    it('pushPending works when task is idle (teammate between turns)', () => {
        const r = new TaskRegistry();
        const t = createTeammateTask({ workerName: 'x', description: '', depth: 0 });
        r.register(t);
        const running = toRunning(t);
        if (!running.ok) throw new Error('setup');
        const idle = toIdle(running.task, 'first result');
        if (!idle.ok) throw new Error('setup');
        r.replace(idle.task);

        expect(r.pushPending(t.id, 'follow up')).toBe(true);
    });
});

describe('TaskRegistry / bulk aborts', () => {
    it('abortAllActive(whole) aborts every non-terminal task', () => {
        const r = new TaskRegistry();
        const a = createTeammateTask({ workerName: 'a', description: '', depth: 0 });
        const b = createTeammateTask({ workerName: 'b', description: '', depth: 0 });
        const c = createTeammateTask({ workerName: 'c', description: '', depth: 0 });
        r.register(a);
        r.register(b);
        r.register(c);
        const cDone = toTerminal(c, 'completed');
        if (cDone.ok) r.replace(cDone.task);

        const n = r.abortAllActive('whole');
        expect(n).toBe(2);
        expect(r.get(a.id)?.abortPair!.whole.signal.aborted).toBe(true);
        expect(r.get(b.id)?.abortPair!.whole.signal.aborted).toBe(true);
        // Terminal tasks are NOT re-aborted (no effect expected on signal state).
    });

    it('abortAllActive(current_turn) leaves whole controller alone', () => {
        const r = new TaskRegistry();
        const a = createTeammateTask({ workerName: 'a', description: '', depth: 0 });
        r.register(a);

        r.abortAllActive('current_turn');
        expect(r.get(a.id)?.abortPair!.currentTurn.signal.aborted).toBe(true);
        expect(r.get(a.id)?.abortPair!.whole.signal.aborted).toBe(false);
    });
});

describe('TaskRegistry / eviction', () => {
    it('evictTerminal removes terminal tasks older than ageMs', () => {
        const r = new TaskRegistry();
        const a = createTeammateTask({ workerName: 'a', description: '', depth: 0 });
        const b = createTeammateTask({ workerName: 'b', description: '', depth: 0 });
        r.register(a);
        r.register(b);

        const doneA = toTerminal(a, 'completed');
        if (!doneA.ok) throw new Error('setup');
        r.replace({ ...doneA.task, endedAt: Date.now() - 60_000 }); // 1 min ago

        const n = r.evictTerminal(30_000); // older than 30s
        expect(n).toBe(1);
        expect(r.has(a.id)).toBe(false);
        expect(r.has(b.id)).toBe(true);
    });

    it('evictTerminal never removes non-terminal tasks', () => {
        const r = new TaskRegistry();
        const a = createTeammateTask({ workerName: 'a', description: '', depth: 0 });
        r.register(a);
        r.replace({ ...a, createdAt: Date.now() - 60 * 60 * 1000 }); // an hour ago, still pending
        expect(r.evictTerminal(0)).toBe(0);
        expect(r.has(a.id)).toBe(true);
    });
});
