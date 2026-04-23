import { describe, it, expect } from 'vitest';
import type { ToolRunContext } from 'flopsygraph';
import { isTeammateTask } from '../../state/task-state';
import { TaskRegistry } from '../../state/task-registry';
import {
    DEFAULT_DELEGATE_TIMEOUT_MS,
    delegateTaskTool,
    type DelegateTaskConfigurable,
} from '../delegate-task';
import {
    MAX_DELEGATION_DEPTH,
    type SubAgentRunner,
} from '../spawn-background-task';

function makeHarness(overrides: Partial<DelegateTaskConfigurable> = {}) {
    const registry = new TaskRegistry();
    let runnerFn: SubAgentRunner = async ({ task }) => `delivered: ${task}`;
    const workerNames = new Set<string>(['legolas', 'gimli']);

    const cfg: DelegateTaskConfigurable = {
        registry,
        buildSubAgent: name => (workerNames.has(name) ? runnerFn : undefined),
        depth: 0,
        ...overrides,
    };

    return {
        registry,
        cfg,
        ctx: { configurable: cfg as unknown as Record<string, unknown> } as ToolRunContext,
        ctxWithSignal(signal: AbortSignal) {
            return {
                configurable: cfg as unknown as Record<string, unknown>,
                signal,
            } as ToolRunContext;
        },
        setRunner(fn: SubAgentRunner) {
            runnerFn = fn;
        },
    };
}

describe('delegateTaskTool / name + schema', () => {
    it('has the expected name', () => {
        expect(delegateTaskTool.name).toBe('delegate_task');
    });

    it('rejects missing worker', async () => {
        const h = makeHarness();
        const result = await delegateTaskTool.run({ task: 'x' }, 'c', h.ctx);
        expect(result.isError).toBe(true);
    });

    it('rejects timeoutMs above the cap', async () => {
        const h = makeHarness();
        const result = await delegateTaskTool.run(
            { worker: 'legolas', task: 'x', timeoutMs: 99_999_999 },
            'c',
            h.ctx,
        );
        expect(result.isError).toBe(true);
    });
});

describe('delegateTaskTool / wiring', () => {
    it('returns a diagnostic when registry missing', async () => {
        const ctx: ToolRunContext = { configurable: {} };
        const result = await delegateTaskTool.run(
            { worker: 'legolas', task: 'x' },
            'c',
            ctx,
        );
        expect(result.output).toMatch(/TaskRegistry/);
    });

    it('unknown worker → friendly error', async () => {
        const h = makeHarness();
        const result = await delegateTaskTool.run(
            { worker: 'saruman', task: 'x' },
            'c',
            h.ctx,
        );
        expect(result.output).toMatch(/unknown worker "saruman"/);
        expect(h.registry.size()).toBe(0);
    });
});

describe('delegateTaskTool / depth', () => {
    it('refuses at max depth', async () => {
        const h = makeHarness({ depth: MAX_DELEGATION_DEPTH });
        const result = await delegateTaskTool.run(
            { worker: 'legolas', task: 'x' },
            'c',
            h.ctx,
        );
        expect(result.output).toMatch(/max delegation depth/i);
        expect(h.registry.size()).toBe(0);
    });
});

describe('delegateTaskTool / happy path', () => {
    it('returns the teammate result verbatim', async () => {
        const h = makeHarness();
        h.setRunner(async ({ task }) => `scouted: ${task}`);
        const result = await delegateTaskTool.run(
            { worker: 'legolas', task: 'the-shire' },
            'c',
            h.ctx,
        );
        expect(result.output).toBe('scouted: the-shire');
        expect(result.isError).toBe(false);

        // Task record should be completed with the result on lastResult.
        const tasks = h.registry.list();
        expect(tasks).toHaveLength(1);
        const t = tasks[0]!;
        expect(t.status).toBe('completed');
        if (isTeammateTask(t)) {
            expect(t.workerName).toBe('legolas');
            expect(t.depth).toBe(1);
            expect(t.lastResult).toBe('scouted: the-shire');
        }
    });

    it('blocks until the runner resolves (genuinely synchronous)', async () => {
        const h = makeHarness();
        h.setRunner(() => new Promise<string>(r => setTimeout(() => r('late'), 50)));
        const t0 = Date.now();
        const result = await delegateTaskTool.run(
            { worker: 'legolas', task: 'x' },
            'c',
            h.ctx,
        );
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeGreaterThanOrEqual(45);
        expect(result.output).toBe('late');
    });

    it('passes toolAllowlist through', async () => {
        const h = makeHarness();
        let seen: readonly string[] | undefined;
        h.setRunner(async ({ toolAllowlist }) => {
            seen = toolAllowlist;
            return 'ok';
        });
        await delegateTaskTool.run(
            { worker: 'legolas', task: 'x', tools: ['web_search', 'wikipedia'] },
            'c',
            h.ctx,
        );
        expect(seen).toEqual(['web_search', 'wikipedia']);
    });
});

describe('delegateTaskTool / abort semantics', () => {
    it('times out and returns a timeout diagnostic', async () => {
        const h = makeHarness();
        h.setRunner(
            ({ signal }) =>
                new Promise<string>((_, reject) => {
                    signal.addEventListener(
                        'abort',
                        () => reject(new Error('aborted')),
                        { once: true },
                    );
                }),
        );
        const result = await delegateTaskTool.run(
            { worker: 'legolas', task: 'x', timeoutMs: 50 },
            'c',
            h.ctx,
        );
        expect(result.output).toMatch(/timed out after 50ms/);
        const tasks = h.registry.list();
        expect(tasks[0]!.status).toBe('killed');
    });

    it('parent signal abort propagates to teammate', async () => {
        const h = makeHarness();
        let receivedAbort = false;
        h.setRunner(
            ({ signal }) =>
                new Promise<string>((_, reject) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            receivedAbort = true;
                            reject(new Error('aborted'));
                        },
                        { once: true },
                    );
                }),
        );
        const parent = new AbortController();
        const run = delegateTaskTool.run(
            { worker: 'legolas', task: 'x' },
            'c',
            h.ctxWithSignal(parent.signal),
        );
        setTimeout(() => parent.abort(), 20);
        const result = await run;
        expect(receivedAbort).toBe(true);
        expect(result.output).toMatch(/parent turn stopped/i);
    });

    it('runner throwing returns a failed diagnostic', async () => {
        const h = makeHarness();
        h.setRunner(async () => {
            throw new Error('model said no');
        });
        const result = await delegateTaskTool.run(
            { worker: 'legolas', task: 'x' },
            'c',
            h.ctx,
        );
        expect(result.output).toMatch(/failed.*model said no/);
        expect(h.registry.list()[0]!.status).toBe('failed');
    });
});

describe('delegateTaskTool / defaults', () => {
    it('default timeout is the documented constant', () => {
        expect(DEFAULT_DELEGATE_TIMEOUT_MS).toBe(180_000);
    });
});
