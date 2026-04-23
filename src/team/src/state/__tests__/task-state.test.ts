import { describe, it, expect } from 'vitest';
import {
    createTeammateTask,
    createBackgroundJobTask,
    createShellTask,
    generateTaskId,
    isActiveStatus,
    isBackgroundJobTask,
    isShellTask,
    isTeammateTask,
    isTerminalStatus,
    rotateCurrentTurnController,
    toIdle,
    toRunning,
    toTerminal,
} from '../task-state';

describe('task-state / IDs (random fallback)', () => {
    it('generates type-prefixed IDs', () => {
        expect(generateTaskId('teammate')).toMatch(/^t[0-9a-z]{4}$/);
        expect(generateTaskId('background_job')).toMatch(/^j[0-9a-z]{4}$/);
        expect(generateTaskId('shell')).toMatch(/^s[0-9a-z]{4}$/);
    });

    it('IDs are unique across 100 calls (birthday-safe at 4 chars: 36^4 ≈ 1.7M)', () => {
        // 4-char suffix gives ~1.68M keyspace per type; at n=100 the collision
        // probability is ~0.3%, good enough for a non-flaky test. Monotonic
        // ids from registry.nextId() are used in production; this random
        // fallback is for unit tests and unregistered callers.
        const ids = new Set(Array.from({ length: 100 }, () => generateTaskId('teammate')));
        expect(ids.size).toBe(100);
    });
});

describe('task-state / status predicates', () => {
    it('classifies terminal statuses', () => {
        expect(isTerminalStatus('completed')).toBe(true);
        expect(isTerminalStatus('failed')).toBe(true);
        expect(isTerminalStatus('killed')).toBe(true);
        expect(isTerminalStatus('running')).toBe(false);
        expect(isTerminalStatus('idle')).toBe(false);
        expect(isTerminalStatus('pending')).toBe(false);
    });

    it('classifies active statuses', () => {
        expect(isActiveStatus('pending')).toBe(true);
        expect(isActiveStatus('running')).toBe(true);
        expect(isActiveStatus('idle')).toBe(false);
        expect(isActiveStatus('completed')).toBe(false);
    });
});

describe('task-state / factories', () => {
    it('teammate task starts pending with empty pending messages', () => {
        const t = createTeammateTask({
            workerName: 'legolas',
            description: 'research iPhone',
            depth: 0,
        });
        expect(t.type).toBe('teammate');
        expect(t.status).toBe('pending');
        expect(t.notified).toBe(false);
        expect(t.pendingMessages).toEqual([]);
        expect(t.workerName).toBe('legolas');
        expect(t.depth).toBe(0);
        expect(t.abortPair).toBeDefined();
        expect(t.abortPair!.whole).toBeInstanceOf(AbortController);
        expect(t.abortPair!.currentTurn).toBeInstanceOf(AbortController);
        expect(t.toolUseCount).toBe(0);
        expect(t.tokenCount).toBe(0);
    });

    it('background_job task starts pending', () => {
        const t = createBackgroundJobTask({
            prompt: 'build weather API',
            description: 'scaffold API',
            depth: 0,
        });
        expect(t.type).toBe('background_job');
        expect(t.status).toBe('pending');
        expect(t.prompt).toBe('build weather API');
    });

    it('shell task starts pending', () => {
        const t = createShellTask({ command: 'ls -la', description: 'list files' });
        expect(t.type).toBe('shell');
        expect(t.status).toBe('pending');
        expect(t.command).toBe('ls -la');
    });
});

describe('task-state / type guards', () => {
    it('guards discriminate correctly', () => {
        const teammate = createTeammateTask({
            workerName: 'legolas',
            description: 'x',
            depth: 0,
        });
        const job = createBackgroundJobTask({ prompt: 'y', description: 'y', depth: 0 });
        const sh = createShellTask({ command: 'z', description: 'z' });

        expect(isTeammateTask(teammate)).toBe(true);
        expect(isTeammateTask(job)).toBe(false);
        expect(isTeammateTask(sh)).toBe(false);

        expect(isBackgroundJobTask(job)).toBe(true);
        expect(isBackgroundJobTask(teammate)).toBe(false);

        expect(isShellTask(sh)).toBe(true);
        expect(isShellTask(job)).toBe(false);

        expect(isTeammateTask(undefined)).toBe(false);
    });
});

describe('task-state / abort pair', () => {
    it('rotating the per-turn controller does not touch the whole controller', () => {
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        const pair = t.abortPair!;
        const nextPair = rotateCurrentTurnController(pair);
        expect(nextPair.whole).toBe(pair.whole);
        expect(nextPair.currentTurn).not.toBe(pair.currentTurn);
        expect(nextPair.currentTurn.signal.aborted).toBe(false);
    });

    it('aborting currentTurn does not abort whole', () => {
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        t.abortPair!.currentTurn.abort();
        expect(t.abortPair!.currentTurn.signal.aborted).toBe(true);
        expect(t.abortPair!.whole.signal.aborted).toBe(false);
    });

    it('aborting whole is independent of currentTurn', () => {
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        t.abortPair!.whole.abort();
        expect(t.abortPair!.whole.signal.aborted).toBe(true);
        expect(t.abortPair!.currentTurn.signal.aborted).toBe(false);
    });
});

describe('task-state / transitions', () => {
    it('pending → running is allowed', () => {
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        const r = toRunning(t);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.task.status).toBe('running');
    });

    it('idle → running is allowed (teammate resumes)', () => {
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        const running = toRunning(t);
        expect(running.ok).toBe(true);
        if (!running.ok) return;
        const idle = toIdle(running.task, 'first result');
        expect(idle.ok).toBe(true);
        if (!idle.ok) return;
        const resumed = toRunning(idle.task);
        expect(resumed.ok).toBe(true);
        if (resumed.ok) expect(resumed.task.status).toBe('running');
    });

    it('toIdle preserves lastResult', () => {
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        const r1 = toRunning(t);
        if (!r1.ok) throw new Error('setup failed');
        const r2 = toIdle(r1.task, 'hello world');
        expect(r2.ok).toBe(true);
        if (!r2.ok) return;
        expect(r2.task.status).toBe('idle');
        expect(r2.task.lastResult).toBe('hello world');
    });

    it('terminal status forbids further transitions', () => {
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        const done = toTerminal(t, 'completed', { result: 'ok' });
        expect(done.ok).toBe(true);
        if (!done.ok) return;
        const rerun = toRunning(done.task);
        expect(rerun.ok).toBe(false);
        const again = toTerminal(done.task, 'killed');
        expect(again.ok).toBe(false);
    });

    it('toTerminal carries result onto teammate as lastResult', () => {
        const t = createTeammateTask({ workerName: 'x', description: 'x', depth: 0 });
        const r = toTerminal(t, 'completed', { result: 'final answer' });
        expect(r.ok).toBe(true);
        if (r.ok && isTeammateTask(r.task)) {
            expect(r.task.lastResult).toBe('final answer');
        }
    });

    it('toTerminal carries result onto background_job as result', () => {
        const t = createBackgroundJobTask({ prompt: 'x', description: 'x', depth: 0 });
        const r = toTerminal(t, 'completed', { result: 'built' });
        expect(r.ok).toBe(true);
        if (r.ok && isBackgroundJobTask(r.task)) {
            expect(r.task.result).toBe('built');
        }
    });

    it('toTerminal on shell records error without result', () => {
        const t = createShellTask({ command: 'ls', description: 'list' });
        const r = toTerminal(t, 'failed', { error: 'permission denied' });
        expect(r.ok).toBe(true);
        if (r.ok && isShellTask(r.task)) {
            expect(r.task.status).toBe('failed');
            expect(r.task.error).toBe('permission denied');
        }
    });
});
