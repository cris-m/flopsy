import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import {
    createBackgroundJobTask,
    createTeammateTask,
    toRunning,
    toTerminal,
} from '../state/task-state';
import type { TaskRegistry } from '../state/task-registry';

export const MAX_DELEGATION_DEPTH = 1;

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
}

/** Implementations MUST honour `signal` for cancellation. */
export type SubAgentRunner = (args: {
    workerName: string;
    task: string;
    toolAllowlist?: readonly string[];
    signal: AbortSignal;
}) => Promise<string>;

export type SubAgentFactory = (workerName: string) => SubAgentRunner | undefined;

export interface SpawnBackgroundTaskConfigurable {
    registry: TaskRegistry;
    eventQueue: BackgroundEventSink;
    buildSubAgent: SubAgentFactory;
    /** Main agent is depth 0; a teammate spawned by the main is depth 1. */
    depth?: number;
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
    tools: z
        .array(z.string())
        .optional()
        .describe(
            'Optional ARRAY of tool-name strings the teammate may use. ' +
            'Always pass a JSON array, never a bare string. ' +
            'Examples: ["web_search"], ["web_search", "web_extract"]. ' +
            'Defaults to the teammate\'s configured toolsets.',
        ),
    description: z
        .string()
        .optional()
        .describe(
            'Short human-readable label for this background job (shown in status queries). Defaults to a truncated task summary.',
        ),
    timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_SPAWN_TIMEOUT_MS)
        .optional()
        .describe(
            `Hard ceiling in ms for how long the teammate can run. Default ${DEFAULT_SPAWN_TIMEOUT_MS} (30 min); max ${MAX_SPAWN_TIMEOUT_MS} (2 h). If it elapses, the teammate is aborted and a task_error event fires — user gets notified.`,
        ),
});

type SpawnArgs = z.infer<typeof schema>;

export const spawnBackgroundTaskTool = defineTool({
    name: 'spawn_background_task',
    description: [
        'Start a long-running task in the background. Returns IMMEDIATELY.',
        'You will be notified via a system task-notification message when it completes.',
        'You can call this multiple times — tasks run in parallel.',
        '',
        'Workers:',
        '  - "legolas"  — quick web scout (<30s). Great when stacking many independent lookups in parallel.',
        '  - "saruman"  — deep researcher. Multi-round plan → search → summarise → reflect with inline citations. USE THIS for landscape briefs, "state of X", multi-angle research, contradiction-surfacing. Takes 3-15 min. Multiple sarumanis on different angles in parallel is normal and encouraged.',
        '  - "gimli"    — analysis of large inputs.',
        '',
        'PARALLELISM — spawn multiple in the same turn when topics are INDEPENDENT:',
        '  Independent = "research X for plan A AND check Y for plan B" — two unrelated reports.',
        '  Not independent = "compare X vs Y" — that\'s ONE worker covering all angles, not three.',
        '  Bad:  spawn(saruman, "research X") → wait → spawn(saruman, "research Y")  [serial when independent]',
        '  Good: emit BOTH spawn() calls in the SAME assistant turn.',
        '',
        'Decision rule — bias to saruman over legolas for anything research-shaped:',
        '  - "state of post-quantum crypto adoption"       → saruman (landscape)',
        '  - "compare LangGraph vs CrewAI vs AutoGen"       → saruman (multi-angle, one worker)',
        '  - "what\'s the consensus on topic X"             → saruman (surfaces disagreement)',
        '  - "what changed in the Rust 2027 edition?"       → legolas (single topic)',
        '',
        'When you spawn: the teammate has NO memory of this conversation — pack everything into the task string:',
        '  - angles / sub-topics / regions / timeframes that matter',
        '  - source hints ("prefer primary sources", "avoid reddit")',
        '  - any specific claims the user wants fact-checked',
        '  - output shape (length, citation style)',
        '',
        'IMMEDIATELY after calling this, call send_message to tell the user it has started.',
        'Do NOT use this when you need the result before you can reply — use delegate_task instead.',
        '',
        'Example call shape (note: tools is an ARRAY of strings):',
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

        const { registry, eventQueue, buildSubAgent, depth, logger, taskStore, threadId } = wiring;

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

        const runner = buildSubAgent(args.worker);
        if (!runner) {
            return `spawn_background_task: unknown worker "${args.worker}". Ensure it exists in the team and is enabled.`;
        }

        const timeoutMs = args.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
        return launch(args, { registry, eventQueue, runner, depth, logger, timeoutMs, taskStore, threadId });
    },
});

interface Wiring {
    registry: TaskRegistry;
    eventQueue: BackgroundEventSink;
    buildSubAgent: SubAgentFactory;
    depth: number;
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
        logger: SpawnBackgroundTaskConfigurable['logger'];
        timeoutMs: number;
        taskStore: BackgroundTaskStore | undefined;
        threadId: string | undefined;
    },
): string {
    const { registry, eventQueue, runner, depth, logger, timeoutMs, taskStore, threadId } = deps;

    const descriptionLabel =
        args.description ?? truncate(args.task, 80);

    const task = createTeammateTask({
        id: registry.nextId('teammate'),
        workerName: args.worker,
        description: descriptionLabel,
        depth: depth + 1,
    });

    registry.register(task);
    const running = toRunning(task);
    if (running.ok) registry.replace(running.task);

    // Persist BEFORE the detached promise fires so a crash mid-spawn leaves a recoverable trail.
    if (taskStore && threadId) {
        try {
            taskStore.recordBackgroundTask({
                taskId: task.id,
                threadId,
                workerName: args.worker,
                taskPrompt: args.task,
                toolAllowlist: args.tools ?? null,
                timeoutMs,
                deliveryMode: null, // delivery_mode is determined at the receiving channel-worker, not the spawn site
                status: 'running',
                createdAt: Date.now(),
                endedAt: null,
                result: null,
                error: null,
                description: descriptionLabel,
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

    // Aborts the WHOLE abort controller so the runner's LLM call sees signal.aborted.
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
}): Promise<void> {
    const { taskId, registry, eventQueue, runner, logger, timeoutTimer, taskStore } = args;
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
        });

        const current = registry.get(taskId);
        if (current) {
            const done = toTerminal(current, 'completed', { result });
            if (done.ok) registry.replace(done.task);
        }

        // Persist BEFORE eventQueue.push so a crash between the two doesn't strand the row as `running`.
        persistStatus('completed', { result });

        eventQueue.push({
            type: 'task_complete',
            taskId,
            result,
            completedAt: Date.now(),
        });
        logger?.info?.({ taskId, durationMs: Date.now() - startedAt }, 'spawn: completed');
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
