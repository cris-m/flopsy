import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import { numberLooseOptional, stringArrayLooseOptional } from './schema-coerce';
import {
    createBackgroundJobTask,
    createTeammateTask,
    toRunning,
    toTerminal,
} from '../state/task-state';
import type { TaskRegistry } from '../state/task-registry';

export const MAX_DELEGATION_DEPTH = 3;

export const DEFAULT_SPAWN_TIMEOUT_MS = 1_800_000; // 30 min
export const MAX_SPAWN_TIMEOUT_MS = 7_200_000; // 2 hours

export interface BackgroundEventSink {
    push(event: BackgroundTaskEvent): void;
}

export interface BackgroundTaskStore {
    recordBackgroundTask(row: {
        taskId: string;
        threadId: string;
        workerName: string;
        taskPrompt: string;
        toolAllowlist: readonly string[] | null;
        timeoutMs: number | null;
        deliveryMode: string | null;
        status: 'running';
        createdAt: number;
        endedAt: null;
        result: null;
        error: null;
        description: string | null;
        kind: 'spawn';
    }): void;
    updateBackgroundTaskStatus(
        taskId: string,
        patch: {
            status: 'running' | 'completed' | 'delivered' | 'failed' | 'killed';
            result?: string;
            error?: string;
            endedAt?: number;
        },
    ): void;
}

export interface BackgroundTaskEvent {
    /** Mirrors ChannelEvent.type — must stay in sync with gateway's union. */
    readonly type: 'task_start' | 'task_complete' | 'task_error' | 'task_progress';
    readonly taskId: string;
    readonly result?: string;
    readonly error?: string;
    readonly progress?: string;
    readonly completedAt: number;
    /** Set for internal worker tasks so ChannelWorker can use <task-notification> format. */
    readonly workerName?: string;
}

/** Implementations MUST honour `signal` for cancellation. */
export type SubAgentRunner = (args: {
    workerName: string;
    task: string;
    toolAllowlist?: readonly string[];
    signal: AbortSignal;
    /** Delegation depth — defaults to 1 when spawned by the main agent. */
    depth?: number;
    /** Chain of worker names that led to this invocation. */
    spawnChain?: string[];
}) => Promise<string>;

export type SubAgentFactory = (workerName: string) => SubAgentRunner | undefined;

export interface SpawnBackgroundTaskConfigurable {
    registry: TaskRegistry;
    eventQueue: BackgroundEventSink;
    buildSubAgent: SubAgentFactory;
    /** Main agent is depth 0; a teammate spawned by the main is depth 1. */
    depth?: number;
    /** Spawn chain tracking for loop prevention. */
    spawnChain?: string[];
    /** When omitted, spawns run memory-only and don't survive a gateway restart. */
    taskStore?: BackgroundTaskStore;
    /** Parent thread for the task (gateway routing key). Required when taskStore is set. */
    threadId?: string;
    /** Optional logger for diagnostics — tool gracefully tolerates missing. */
    logger?: {
        info?: (payload: Record<string, unknown>, msg?: string) => void;
        warn?: (payload: Record<string, unknown>, msg?: string) => void;
        error?: (payload: Record<string, unknown>, msg?: string) => void;
    };
}

const schema = z.object({
    worker: z
        .string()
        .min(1)
        .describe(
            'Teammate role to delegate to (e.g. "legolas", "gimli"). Must be a configured worker.',
        ),
    task: z
        .string()
        .min(1)
        .describe(
            'Full task description for the teammate. The teammate has no access to conversation history, so include any context needed.',
        ),
    tools: stringArrayLooseOptional()
        .describe(
            'Optional list of tool-name strings the teammate may use. ' +
            'Pass a JSON array (e.g. ["web_search", "web_extract"]); a bare string ' +
            'like "web_search" is also accepted and auto-wrapped. ' +
            'Defaults to the teammate\'s configured toolsets.',
        ),
    description: z
        .string()
        .optional()
        .describe(
            'Short human-readable label for this background job (shown in status queries). Defaults to a truncated task summary.',
        ),
    timeoutMs: numberLooseOptional()
        .pipe(z.number().int().positive().max(MAX_SPAWN_TIMEOUT_MS).optional())
        .describe(
            `Hard ceiling in ms for how long the teammate can run. Default ${DEFAULT_SPAWN_TIMEOUT_MS} (30 min); max ${MAX_SPAWN_TIMEOUT_MS} (2 h). Pass as a number (e.g. 600000); a quoted string ("600000") is also accepted. If it elapses, the teammate is aborted and a task_error event fires — user gets notified.`,
        ),
    outputFile: z
        .string()
        .optional()
        .describe(
            'Absolute path to write the task output to when complete. Use for large outputs that should not be inlined in the notification (e.g. "/workspace/reports/pq-crypto.md"). Read with read_file after task completion. When omitted, output is delivered inline.',
        ),
});

// Override `tools`/`timeoutMs` so consumers see the post-coercion shape
// (string[] / number) rather than the union of accepted inputs that
// `z.infer` reports for `union → transform → optional` fields.
type SpawnArgs = Omit<z.infer<typeof schema>, 'tools' | 'timeoutMs'> & {
    tools?: string[];
    timeoutMs?: number;
};

export const spawnBackgroundTaskTool = defineTool({
    name: 'spawn_background_task',
    description: [
        'Start a long-running task in the background and return IMMEDIATELY. You\'ll be notified via a system task-notification message when it completes; multiple spawns run in parallel.',
        'Use this when the task takes longer than ~2 minutes OR when the user shouldn\'t wait. For quick work you need before replying, use delegate_task instead.',
        '',
        'Pick the worker:',
        '  - "saruman"  — deep multi-round research with citations. Default for "state of X", multi-angle briefs, contradiction-surfacing. 3–15 min.',
        '  - "legolas"  — quick web scout (<30s). Use when stacking many independent lookups in parallel.',
        '  - "gimli"    — analysis of large structured inputs.',
        '',
        'Examples: "state of post-quantum crypto" → saruman. "compare LangGraph vs CrewAI vs AutoGen" → saruman (one worker, multi-angle). "what changed in the Rust 2027 edition?" → legolas. "review this 200-line config" → gimli.',
        '',
        'Spawn multiple in the same turn when topics are independent (e.g., "research X for plan A AND check Y for plan B"). Don\'t serialize independent work.',
        'Right after spawning, call send_message to tell the user it has started.',
        '',
        'The teammate has NO memory of the conversation — pack into the task string: angles, source hints, claims to fact-check, output shape. The teammate CAN delegate further if the task crosses domains (max depth = 3, loops are blocked).',
        '',
        'Example call:',
        '  {',
        '    "worker": "saruman",',
        '    "task": "Brief on the post-quantum crypto landscape, 5 angles, primary sources only.",',
        '    "tools": ["web_search", "web_extract"],',
        '    "description": "PQ crypto landscape brief",',
        '    "timeoutMs": 600000',
        '  }',
    ].join('\n'),
    schema,
    execute: async (args, ctx) => {
        const cfg = (ctx.configurable ?? {}) as Partial<SpawnBackgroundTaskConfigurable>;

        const wiring = validateWiring(cfg);
        if (typeof wiring === 'string') return wiring;

        const { registry, eventQueue, buildSubAgent, depth, chain, logger, taskStore, threadId } = wiring;

        const taskPreview = args.task.length > 160
            ? args.task.slice(0, 157) + '…'
            : args.task;
        logger?.info?.(
            {
                op: 'spawn_background_task',
                worker: args.worker,
                depth,
                timeoutMs: args.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
                taskPreview,
            },
            'spawn_background_task invoked',
        );

        if (depth >= MAX_DELEGATION_DEPTH) {
            return `spawn_background_task: max delegation depth (${MAX_DELEGATION_DEPTH}) reached. Handle this task directly.`;
        }

        if (chain.includes(args.worker)) {
            return `spawn_background_task: loop detected — ${args.worker} already in chain [${chain.join(' → ')}]. Handle directly.`;
        }

        const runner = buildSubAgent(args.worker);
        if (!runner) {
            return `spawn_background_task: unknown worker "${args.worker}". Ensure it exists in the team and is enabled.`;
        }

        // Cast to the post-transform shape (TS infers the pre-transform union).
        const coerced = args as unknown as SpawnArgs;
        const timeoutMs = coerced.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
        return launch(coerced, { registry, eventQueue, runner, depth, chain, logger, timeoutMs, taskStore, threadId });
    },
});

interface Wiring {
    registry: TaskRegistry;
    eventQueue: BackgroundEventSink;
    buildSubAgent: SubAgentFactory;
    depth: number;
    chain: string[];
    logger: SpawnBackgroundTaskConfigurable['logger'];
    taskStore: BackgroundTaskStore | undefined;
    threadId: string | undefined;
}

function validateWiring(
    cfg: Partial<SpawnBackgroundTaskConfigurable>,
): Wiring | string {
    if (!cfg.registry) {
        return 'spawn_background_task: no TaskRegistry configured. This tool must be invoked inside a TeamHandler-managed turn.';
    }
    if (!cfg.eventQueue) {
        return 'spawn_background_task: no eventQueue configured. Ensure AgentCallbacks are forwarded into configurable.';
    }
    if (typeof cfg.buildSubAgent !== 'function') {
        return 'spawn_background_task: no buildSubAgent factory configured.';
    }
    return {
        registry: cfg.registry,
        eventQueue: cfg.eventQueue,
        buildSubAgent: cfg.buildSubAgent,
        depth: cfg.depth ?? 0,
        chain: cfg.spawnChain ?? [],
        logger: cfg.logger,
        taskStore: cfg.taskStore,
        threadId: cfg.threadId,
    };
}

function launch(
    args: SpawnArgs,
    deps: {
        registry: TaskRegistry;
        eventQueue: BackgroundEventSink;
        runner: SubAgentRunner;
        depth: number;
        chain: string[];
        logger: SpawnBackgroundTaskConfigurable['logger'];
        timeoutMs: number;
        taskStore: BackgroundTaskStore | undefined;
        threadId: string | undefined;
    },
): string {
    const { registry, eventQueue, runner, depth, chain, logger, timeoutMs, taskStore, threadId } = deps;

    const descriptionLabel =
        args.description ?? truncate(args.task, 80);

    const task = createTeammateTask({
        id: registry.nextId('teammate'),
        workerName: args.worker,
        description: descriptionLabel,
        depth: depth + 1,
        spawnChain: [...chain, args.worker],
    });

    registry.register(task);
    const running = toRunning(task);
    if (running.ok) registry.replace(running.task);

    // Persist BEFORE the detached promise fires so a crash mid-spawn is recoverable.
    if (taskStore && threadId) {
        try {
            taskStore.recordBackgroundTask({
                taskId: task.id,
                threadId,
                workerName: args.worker,
                taskPrompt: args.task,
                toolAllowlist: args.tools ?? null,
                timeoutMs,
                deliveryMode: null,
                status: 'running',
                createdAt: Date.now(),
                endedAt: null,
                result: null,
                error: null,
                description: descriptionLabel,
                kind: 'spawn',
            });
        } catch (err) {
            logger?.warn?.(
                {
                    op: 'spawn_background_task',
                    taskId: task.id,
                    err: err instanceof Error ? err.message : String(err),
                },
                'failed to persist background_task row — task will run in memory-only mode',
            );
        }
    }

    eventQueue.push({
        type: 'task_start',
        taskId: task.id,
        completedAt: Date.now(),
    });

    // Aborts the whole controller so the runner's LLM call sees signal.aborted.
    const timeoutTimer = setTimeout(() => {
        logger?.warn?.(
            { taskId: task.id, worker: args.worker, timeoutMs },
            'spawn_background_task: ceiling reached, aborting',
        );
        task.abortPair?.whole.abort();
    }, timeoutMs);

    void runInBackground({
        taskId: task.id,
        workerName: args.worker,
        taskPrompt: args.task,
        toolAllowlist: args.tools,
        abortSignal: task.abortPair!.whole.signal,
        registry,
        eventQueue,
        runner,
        logger,
        timeoutTimer,
        taskStore,
        outputFile: args.outputFile,
        spawnChain: [...chain, args.worker],
        depth: depth + 1,
    });

    logger?.info?.(
        {
            taskId: task.id,
            worker: args.worker,
            depth: depth + 1,
            descriptionLabel,
            timeoutMs,
        },
        'spawn_background_task: started',
    );

    return `#${task.id} started → ${args.worker}`;
}

async function runInBackground(args: {
    taskId: string;
    workerName: string;
    taskPrompt: string;
    toolAllowlist?: readonly string[];
    abortSignal: AbortSignal;
    registry: TaskRegistry;
    eventQueue: BackgroundEventSink;
    runner: SubAgentRunner;
    logger: SpawnBackgroundTaskConfigurable['logger'];
    timeoutTimer: NodeJS.Timeout;
    taskStore: BackgroundTaskStore | undefined;
    outputFile: string | undefined;
    spawnChain: string[];
    depth: number;
}): Promise<void> {
    const { taskId, workerName, registry, eventQueue, runner, logger, timeoutTimer, taskStore, outputFile } = args;
    const startedAt = Date.now();

    const persistStatus = (
        status: 'completed' | 'failed' | 'killed',
        patch: { result?: string; error?: string },
    ): void => {
        if (!taskStore) return;
        try {
            taskStore.updateBackgroundTaskStatus(taskId, { status, ...patch });
        } catch (err) {
            logger?.warn?.(
                {
                    taskId,
                    err: err instanceof Error ? err.message : String(err),
                    op: 'persistStatus',
                },
                'failed to persist background_task terminal status — row may be stranded as running',
            );
        }
    };

    try {
        const result = await runner({
            workerName: args.workerName,
            task: args.taskPrompt,
            toolAllowlist: args.toolAllowlist,
            signal: args.abortSignal,
            depth: args.depth,
            spawnChain: args.spawnChain,
        });

        let deliveredResult = result;
        if (outputFile) {
            try {
                mkdirSync(dirname(outputFile), { recursive: true });
                writeFileSync(outputFile, result, 'utf8');
                // Inline alongside the file write when small enough; small models otherwise
                // just say "task done, read the file" and never surface the body.
                const INLINE_THRESHOLD = 16_000;
                if (result.length > INLINE_THRESHOLD) {
                    deliveredResult = `Output written to ${outputFile} (${result.length} chars — too large to inline). Read it with read_file before replying to the user.`;
                } else {
                    deliveredResult = `${result}\n\n_(Full output also saved to ${outputFile} for later reference.)_`;
                }
            } catch (writeErr) {
                logger?.warn?.(
                    {
                        taskId,
                        outputFile,
                        err: writeErr instanceof Error ? writeErr.message : String(writeErr),
                    },
                    'failed to write outputFile — falling back to inline delivery',
                );
            }
        }

        const current = registry.get(taskId);
        if (current) {
            const done = toTerminal(current, 'completed', { result: deliveredResult });
            if (done.ok) registry.replace(done.task);
        }

        // Persist BEFORE eventQueue.push so a crash between the two doesn't strand `running`.
        persistStatus('completed', { result: deliveredResult });

        eventQueue.push({
            type: 'task_complete',
            taskId,
            result: deliveredResult,
            completedAt: Date.now(),
            workerName,
        });
        logger?.info?.({ taskId, durationMs: Date.now() - startedAt, outputFile: outputFile ?? null }, 'spawn: completed');
    } catch (err) {
        const aborted = args.abortSignal.aborted;
        const status: 'failed' | 'killed' = aborted ? 'killed' : 'failed';
        const message = err instanceof Error ? err.message : String(err);

        const current = registry.get(taskId);
        if (current) {
            const terminal = toTerminal(current, status, { error: message });
            if (terminal.ok) registry.replace(terminal.task);
        }

        persistStatus(status, { error: message });

        eventQueue.push({
            type: 'task_error',
            taskId,
            error: message,
            completedAt: Date.now(),
            workerName,
        });
        logger?.warn?.(
            { taskId, durationMs: Date.now() - startedAt, err: message, aborted },
            'spawn: failed',
        );
    } finally {
        clearTimeout(timeoutTimer);
    }
}

function truncate(s: string, max: number): string {
    const oneLine = s.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= max) return oneLine;
    return oneLine.slice(0, max - 1).trimEnd() + '…';
}

export { createBackgroundJobTask };
