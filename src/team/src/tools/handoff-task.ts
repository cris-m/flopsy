import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import {
    createTeammateTask,
    toRunning,
    toTerminal,
} from '../state/task-state';
import type { TaskRegistry } from '../state/task-registry';
import type {
    SpawnBackgroundTaskConfigurable,
    SubAgentFactory,
} from './spawn-background-task';
import { MAX_DELEGATION_DEPTH } from './spawn-background-task';
import type { DelegateRunStore } from './delegate-task';

export const HANDOFF_TIMEOUT_MS = 300_000;

export type HandoffTaskConfigurable = Pick<
    SpawnBackgroundTaskConfigurable,
    'registry' | 'buildSubAgent' | 'depth' | 'logger'
> & {
    spawnChain?: string[];
    runStore?: DelegateRunStore;
    threadId?: string;
    agentName?: string;
};

const schema = z.object({
    peer: z
        .string()
        .min(1)
        .describe('Teammate to hand the task off to — name from your team roster.'),
    original_brief: z
        .string()
        .min(1)
        .describe(
            'The full original task as you received it. Pass it VERBATIM — the peer has no conversation history. Do NOT paraphrase or summarise; the peer needs the same input you got.',
        ),
    why_handoff: z
        .string()
        .min(1)
        .describe(
            'One short sentence explaining why this task belongs to the peer, not you. ' +
            'Examples: "Whole task is research domain, not security", "Needs YouTube MCP which I don\'t have".',
        ),
});

type HandoffArgs = z.infer<typeof schema>;

export const handoffTaskTool = defineTool({
    name: 'handoff_task',
    description: [
        'Hand off the ENTIRE current task to a peer worker. The peer\'s reply will be returned to the main agent as-is — you will NOT see it, you will NOT synthesize.',
        '',
        'Use this when the main agent routed the task to you but it actually belongs entirely to a peer. Pick the right peer from the team roster in your system prompt — match the task domain to the peer\'s `whenToUse`.',
        '',
        'Difference from `delegate_task`:',
        '- `delegate_task` = "do this sub-task and return, I\'ll integrate". Caller waits, then synthesizes.',
        '- `handoff_task`  = "this entire task is yours, your reply IS the answer". Caller is done.',
        '',
        'When to handoff vs delegate:',
        '- Whole task is out of your domain → handoff_task',
        '- Part of task crosses domains, part is yours → delegate_task for the crossing part, integrate yourself',
        '- Stuck after 2 attempts → delegate_task for a peer\'s perspective, integrate; don\'t handoff (you still contributed)',
        '',
        'Guards: depth ≤3, peer cannot already be in chain. Same as delegate_task.',
        '',
        'Pass the original brief VERBATIM — peers have no memory of what the main agent said. Your `why_handoff` shows up in logs so the main agent can learn to route better next time.',
    ].join('\n'),
    schema,
    execute: async (args, ctx) => {
        const cfg = (ctx.configurable ?? {}) as Partial<HandoffTaskConfigurable>;
        if (!cfg.registry) {
            return 'handoff_task: no TaskRegistry configured. This tool must run inside a TeamHandler-managed turn.';
        }
        if (typeof cfg.buildSubAgent !== 'function') {
            return 'handoff_task: no buildSubAgent factory configured.';
        }
        const registry = cfg.registry;
        const buildSubAgent = cfg.buildSubAgent;
        const depth = cfg.depth ?? 0;
        const chain = cfg.spawnChain ?? [];
        const logger = cfg.logger;
        const fromWorker = cfg.agentName ?? 'unknown';

        if (depth >= MAX_DELEGATION_DEPTH) {
            return `handoff_task: max chain depth (${MAX_DELEGATION_DEPTH}) reached. Handle directly or escalate to the main agent.`;
        }
        if (chain.includes(args.peer)) {
            return `handoff_task: loop detected — ${args.peer} already in chain [${chain.join(' → ')}]. Handle directly.`;
        }
        if (args.peer === fromWorker) {
            return `handoff_task: cannot hand off to yourself (${args.peer}).`;
        }

        const runner = buildSubAgent(args.peer);
        if (!runner) {
            return `handoff_task: unknown peer "${args.peer}". Verify the team roster.`;
        }

        const briefForPeer = [
            `[Handoff from ${fromWorker}: ${args.why_handoff}]`,
            '',
            args.original_brief,
        ].join('\n');

        const task = createTeammateTask({
            id: registry.nextId('teammate'),
            workerName: args.peer,
            description: `[handoff] ${args.original_brief.slice(0, 100)}`,
            depth: depth + 1,
            spawnChain: [...chain, args.peer],
        });
        registry.register(task);
        const running = toRunning(task);
        if (running.ok) registry.replace(running.task);

        const whole = task.abortPair!.whole;
        const startedAt = Date.now();
        const timer: NodeJS.Timeout = setTimeout(() => whole.abort(), HANDOFF_TIMEOUT_MS);
        const unlinkParent = ctx.signal
            ? linkSignal(ctx.signal, () => whole.abort())
            : undefined;

        logger?.info?.(
            {
                op: 'handoff_task',
                from: fromWorker,
                to: args.peer,
                depth,
                why: args.why_handoff,
            },
            'handoff_task invoked',
        );

        try {
            const result = await runner({
                workerName: args.peer,
                task: briefForPeer,
                signal: whole.signal,
                depth: depth + 1,
                spawnChain: [...chain, args.peer],
            });

            const done = toTerminal(task, 'completed', { result });
            if (done.ok) registry.replace(done.task);

            logger?.info?.(
                {
                    op: 'handoff_task',
                    from: fromWorker,
                    to: args.peer,
                    durationMs: Date.now() - startedAt,
                    replyLength: result.length,
                },
                'handoff_task: peer completed',
            );

            if (cfg.runStore && cfg.threadId) {
                try {
                    cfg.runStore.recordDelegateRun({
                        taskId: task.id,
                        threadId: cfg.threadId,
                        workerName: args.peer,
                        taskPrompt: briefForPeer,
                        toolAllowlist: null,
                        startedAtMs: startedAt,
                        endedAtMs: Date.now(),
                        status: 'completed',
                        result,
                        error: null,
                    });
                } catch (err) {
                    logger?.warn?.({ err, taskId: task.id }, 'handoff_task: telemetry write failed (non-fatal)');
                }
            }

            return result;
        } catch (err) {
            const aborted = whole.signal.aborted;
            const timedOut = aborted && Date.now() - startedAt >= HANDOFF_TIMEOUT_MS - 100;
            const message = err instanceof Error ? err.message : String(err);
            const terminal = toTerminal(task, aborted ? 'killed' : 'failed', { error: message });
            if (terminal.ok) registry.replace(terminal.task);
            logger?.warn?.(
                {
                    op: 'handoff_task',
                    from: fromWorker,
                    to: args.peer,
                    aborted,
                    timedOut,
                    err: message,
                },
                'handoff_task: aborted or failed',
            );
            if (timedOut) {
                return `handoff_task: peer ${args.peer} timed out after ${HANDOFF_TIMEOUT_MS}ms. Return to the main agent with the partial findings.`;
            }
            if (aborted) {
                return `handoff_task: peer ${args.peer} aborted before completion.`;
            }
            return `handoff_task: peer ${args.peer} failed: ${message}`;
        } finally {
            clearTimeout(timer);
            unlinkParent?.();
        }
    },
});

function linkSignal(signal: AbortSignal, onAbort: () => void): () => void {
    if (signal.aborted) {
        onAbort();
        return () => {};
    }
    const handler = () => onAbort();
    signal.addEventListener('abort', handler, { once: true });
    return () => signal.removeEventListener('abort', handler);
}
