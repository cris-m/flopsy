import { describe, it, expect } from 'vitest';
import type { ToolRunContext } from 'flopsygraph';
import { isTeammateTask } from '../../state/task-state';
import { TaskRegistry } from '../../state/task-registry';
import {
    MAX_DELEGATION_DEPTH,
    spawnBackgroundTaskTool,
    type BackgroundTaskEvent,
    type SpawnBackgroundTaskConfigurable,
    type SubAgentRunner,
} from '../spawn-background-task';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeHarness(overrides: Partial<SpawnBackgroundTaskConfigurable> = {}) {
    const registry = new TaskRegistry();
    // We capture only terminal events (task_complete / task_error). The
    // synchronous `task_start` signal that fires the gateway's typing /
    // reaction loop is auxiliary and not under test here — filtering it
    // keeps these tests focused on runner-result wiring.
    const events: BackgroundTaskEvent[] = [];
    const eventQueue = {
        push: (e: BackgroundTaskEvent) => {
            if (e.type === 'task_start' || e.type === 'task_progress') return;
            events.push(e);
        },
    };

    let runnerFn: SubAgentRunner = async ({ task }) => `ran: ${task}`;
    const workerNames = new Set<string>(['legolas', 'gimli']);

    const cfg: SpawnBackgroundTaskConfigurable = {
        registry,
        eventQueue,
        buildSubAgent: name => (workerNames.has(name) ? runnerFn : undefined),
        depth: 0,
        ...overrides,
    };

    return {
        registry,
        events,
        cfg,
        ctx: { configurable: cfg as unknown as Record<string, unknown> } as ToolRunContext,
        setRunner(fn: SubAgentRunner) {
            runnerFn = fn;
        },
        addWorker(name: string) {
            workerNames.add(name);
        },
        removeWorker(name: string) {
            workerNames.delete(name);
        },
    };
}

async function waitFor(
    predicate: () => boolean,
    opts: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
    const deadline = Date.now() + (opts.timeoutMs ?? 1000);
    while (!predicate() && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, opts.stepMs ?? 5));
    }
    if (!predicate()) throw new Error('waitFor: predicate never held');
}

function extractTaskId(output: string): string {
    // Registry-scoped ids look like `t1`, `t2`, ... so the output is
    // e.g. "#t1 started → legolas". Also tolerate the random fallback
    // (`t3a7`) for call sites that don't pass a registry id.
    const m = /^#(t[0-9a-z]+)/.exec(output);
    if (!m) throw new Error(`extractTaskId: no id in "${output}"`);
    return m[1]!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('spawnBackgroundTaskTool / name + schema', () => {
    it('has the expected name', () => {
        expect(spawnBackgroundTaskTool.name).toBe('spawn_background_task');
    });

    it('rejects missing worker', async () => {
        const h = makeHarness();
        const result = await spawnBackgroundTaskTool.run({ task: 'research' }, 'c', h.ctx);
        expect(result.isError).toBe(true);
    });

    it('rejects missing task', async () => {
        const h = makeHarness();
        const result = await spawnBackgroundTaskTool.run({ worker: 'legolas' }, 'c', h.ctx);
        expect(result.isError).toBe(true);
    });
});

describe('spawnBackgroundTaskTool / wiring checks', () => {
    it('returns a diagnostic when TaskRegistry is missing', async () => {
        const ctx: ToolRunContext = { configurable: {} };
        const result = await spawnBackgroundTaskTool.run(
            { worker: 'legolas', task: 'x' },
            'c',
            ctx,
        );
        expect(result.output).toMatch(/TaskRegistry/);
    });

    it('returns a diagnostic when buildSubAgent factory is missing', async () => {
        const ctx: ToolRunContext = {
            configurable: {
                registry: new TaskRegistry(),
                eventQueue: { push: () => {} },
            },
        };
        const result = await spawnBackgroundTaskTool.run(
            { worker: 'legolas', task: 'x' },
            'c',
            ctx,
        );
        expect(result.output).toMatch(/buildSubAgent/);
    });

    it('returns a friendly error for an unknown worker', async () => {
        const h = makeHarness();
        const result = await spawnBackgroundTaskTool.run(
            { worker: 'saruman', task: 'betray' },
            'c',
            h.ctx,
        );
        expect(result.output).toMatch(/unknown worker "saruman"/);
        expect(h.registry.size()).toBe(0);
    });
});

describe('spawnBackgroundTaskTool / depth limit', () => {
    it('refuses when depth >= MAX_DELEGATION_DEPTH', async () => {
        const h = makeHarness({ depth: MAX_DELEGATION_DEPTH });
        const result = await spawnBackgroundTaskTool.run(
            { worker: 'legolas', task: 'x' },
            'c',
            h.ctx,
        );
        expect(result.output).toMatch(/max delegation depth/i);
        expect(h.registry.size()).toBe(0);
    });

    it('allows when depth < MAX_DELEGATION_DEPTH', async () => {
        const h = makeHarness({ depth: 0 });
        const result = await spawnBackgroundTaskTool.run(
            { worker: 'legolas', task: 'x' },
            'c',
            h.ctx,
        );
        expect(result.output).toMatch(/^#t[0-9a-z]+ started → legolas$/);
    });
});

describe('spawnBackgroundTaskTool / fire-and-forget mechanics', () => {
    it('returns immediately with a task id and the worker name', async () => {
        const h = makeHarness();
        h.setRunner(
            () =>
                new Promise<string>(resolve => {
                    setTimeout(() => resolve('eventually'), 200);
                }),
        );

        const t0 = Date.now();
        const result = await spawnBackgroundTaskTool.run(
            { worker: 'legolas', task: 'deep research' },
            'c',
            h.ctx,
        );
        const elapsed = Date.now() - t0;

        expect(result.output).toMatch(/^#t[0-9a-z]+ started → legolas$/);
        expect(elapsed).toBeLessThan(100);
    });

    it('registers a teammate task in running state, at depth+1', async () => {
        // Use a blocking runner so the detached Promise can't reach its
        // completion transition before we observe the running state.
        const h = makeHarness({ depth: 0 });
        h.setRunner(() => new Promise<string>(() => {}));

        await spawnBackgroundTaskTool.run(
            { worker: 'legolas', task: 'scout' },
            'c',
            h.ctx,
        );
        const tasks = h.registry.list();
        expect(tasks).toHaveLength(1);
        const t = tasks[0]!;
        expect(isTeammateTask(t)).toBe(true);
        if (isTeammateTask(t)) {
            expect(t.workerName).toBe('legolas');
            expect(t.depth).toBe(1);
            expect(t.status).toBe('running');
        }
        // Clean up — abort the blocker so node doesn't hold the event loop.
        t.abortPair?.whole.abort();
    });

    it('pushes task_complete event when the runner resolves', async () => {
        const h = makeHarness();
        h.setRunner(async ({ task }) => `scouted: ${task}`);
        const startResult = await spawnBackgroundTaskTool.run(
            { worker: 'legolas', task: 'the-shire' },
            'c',
            h.ctx,
        );
        const taskId = extractTaskId(startResult.output);

        await waitFor(() => h.events.length === 1);
        const ev = h.events[0]!;
        expect(ev.type).toBe('task_complete');
        expect(ev.taskId).toBe(taskId);
        expect(ev.result).toBe('scouted: the-shire');

        const task = h.registry.get(taskId);
        expect(task?.status).toBe('completed');
        if (task && isTeammateTask(task)) {
            expect(task.lastResult).toBe('scouted: the-shire');
        }
    });

    it('pushes task_error event when the runner throws', async () => {
        const h = makeHarness();
        h.setRunner(async () => {
            throw new Error('model timed out');
        });
        const startResult = await spawnBackgroundTaskTool.run(
            { worker: 'legolas', task: 'x' },
            'c',
            h.ctx,
        );
        const taskId = extractTaskId(startResult.output);

        await waitFor(() => h.events.length === 1);
        const ev = h.events[0]!;
        expect(ev.type).toBe('task_error');
        expect(ev.taskId).toBe(taskId);
        expect(ev.error).toBe('model timed out');
        expect(h.registry.get(taskId)?.status).toBe('failed');
    });

    it('aborting via task.abortPair.whole transitions to killed', async () => {
        const h = makeHarness();
        h.setRunner(async ({ signal }) => {
            return new Promise<string>((_, reject) => {
                const onAbort = () => reject(new Error('aborted'));
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort);
            });
        });

        const startResult = await spawnBackgroundTaskTool.run(
            { worker: 'legolas', task: 'x' },
            'c',
            h.ctx,
        );
        const taskId = extractTaskId(startResult.output);
        h.registry.get(taskId)?.abortPair?.whole.abort();

        await waitFor(() => h.events.length === 1);
        expect(h.events[0]!.type).toBe('task_error');
        expect(h.registry.get(taskId)?.status).toBe('killed');
    });

    it('parallel spawns run concurrently and each emits its own event', async () => {
        const h = makeHarness();
        let running = 0;
        let maxSeen = 0;
        h.setRunner(async ({ task }) => {
            running++;
            maxSeen = Math.max(maxSeen, running);
            await new Promise(r => setTimeout(r, 20));
            running--;
            return `done: ${task}`;
        });

        await spawnBackgroundTaskTool.run({ worker: 'legolas', task: 'a' }, 'c1', h.ctx);
        await spawnBackgroundTaskTool.run({ worker: 'legolas', task: 'b' }, 'c2', h.ctx);
        await spawnBackgroundTaskTool.run({ worker: 'gimli', task: 'c' }, 'c3', h.ctx);

        await waitFor(() => h.events.length === 3);
        expect(maxSeen).toBeGreaterThanOrEqual(2);
        const results = h.events.map(e => e.result).sort();
        expect(results).toEqual(['done: a', 'done: b', 'done: c']);
    });
});

describe('spawnBackgroundTaskTool / description label', () => {
    it('uses the provided description verbatim when short', async () => {
        const h = makeHarness();
        const out = await spawnBackgroundTaskTool.run(
            { worker: 'legolas', task: 'x', description: 'scouting mission' },
            'c',
            h.ctx,
        );
        const taskId = extractTaskId(out.output);
        expect(h.registry.get(taskId)?.description).toBe('scouting mission');
    });

    it('falls back to a truncated task string when no description provided', async () => {
        const h = makeHarness();
        const longTask = 'word '.repeat(100);
        const out = await spawnBackgroundTaskTool.run(
            { worker: 'legolas', task: longTask },
            'c',
            h.ctx,
        );
        const taskId = extractTaskId(out.output);
        const desc = h.registry.get(taskId)?.description ?? '';
        expect(desc.length).toBeLessThanOrEqual(80);
        expect(desc.endsWith('…')).toBe(true);
    });
});
