/**
 * spawn_background_task — fire-and-forget delegation.
 *
 * The leader agent (gandalf) calls this tool to hand a task to a named
 * teammate (legolas, gimli) that runs in the background. The tool:
 *   1. Creates a TaskState in the TaskRegistry.
 *   2. Fires a detached Promise that runs the teammate's sub-agent.
 *   3. Returns immediately with `#<taskId> started → <worker>`.
 *   4. On completion (or failure), pushes a ChannelEvent to the gateway's
 *      event queue. The gateway's ChannelWorker picks that up and calls
 *      handler.invoke() again with a task-notification as a system message —
 *      the leader sees it, and decides what to do next.
 *
 * The leader's turn ENDS after this tool returns. It should follow up with
 * `send_message("On it...")` to acknowledge, then let the turn close.
 *
 * Depth limit: sub-agents cannot spawn sub-agents (MAX_DEPTH = 1). The tool
 * reads ctx.configurable.depth; if already >= MAX_DEPTH, it refuses.
 */

import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import {
    createBackgroundJobTask,
    createTeammateTask,
    toRunning,
    toTerminal,
} from '../state/task-state';
import type { TaskRegistry } from '../state/task-registry';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export const MAX_DELEGATION_DEPTH = 1;

// Background tasks run detached — no parent turn to bound them. Without a
// ceiling a stuck worker would sit forever consuming a model slot, and
// unrelated cleanup (channel restart, process signal) would be the only
// way to free it. Defaults balance "research can take a while" vs "don't
// leak workers".
export const DEFAULT_SPAWN_TIMEOUT_MS = 1_800_000; // 30 min
export const MAX_SPAWN_TIMEOUT_MS = 7_200_000; // 2 hours

/**
 * Minimal shape of the gateway's event queue. Matches
 * `@flopsy/gateway` IEventQueue but is declared here so this file doesn't
 * drag in gateway types (tools live inside the team package).
 */
export interface BackgroundEventSink {
    push(event: BackgroundTaskEvent): void;
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

/**
 * The factory TeamHandler injects so the tool can build a sub-agent on
 * demand. TeamHandler owns the teammate definitions and the shared model;
 * the tool only knows "give me a runner for worker `name`."
 *
 * The returned function runs the sub-agent turn and returns its final text.
 * Implementations should honour `signal` for cancellation.
 */
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
    /** Optional logger for diagnostics — tool gracefully tolerates missing. */
    logger?: {
        info?: (payload: Record<string, unknown>, msg?: string) => void;
        warn?: (payload: Record<string, unknown>, msg?: string) => void;
        error?: (payload: Record<string, unknown>, msg?: string) => void;
    };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

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
            'Optional allowlist of tool names the teammate may use. Defaults to the teammate\'s configured toolsets.',
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

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const spawnBackgroundTaskTool = defineTool({
    name: 'spawn_background_task',
    description: [
        'Start a long-running task in the background. Returns IMMEDIATELY.',
        'You will be notified via a system task-notification message when it completes.',
        'You can call this multiple times — tasks run in parallel.',
        '',
        'Workers:',
        '  - "legolas"  — quick web scout (<30s). Use only for spawn when you\'re stacking many lookups in parallel.',
        '  - "saruman"  — deep researcher. Multi-round plan → search → summarise → reflect, with inline citations. USE THIS for landscape briefs, "state of X", multi-angle research, contradiction-surfacing. Takes 3-15 min.',
        '  - "gimli"    — analysis of large inputs.',
        '',
        'Decision rule — bias to saruman over legolas for anything research-shaped:',
        '  - "state of post-quantum crypto adoption"       → saruman (landscape)',
        '  - "compare LangGraph vs CrewAI vs AutoGen"       → saruman (multi-angle)',
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
    ].join('\n'),
    schema,
    execute: async (args, ctx) => {
        const cfg = (ctx.configurable ?? {}) as Partial<SpawnBackgroundTaskConfigurable>;

        const wiring = validateWiring(cfg);
        if (typeof wiring === 'string') return wiring;

        const { registry, eventQueue, buildSubAgent, depth, logger } = wiring;

        // Lifecycle INFO — matches delegate_task. Operators want to see
        // async spawns in logs with the decision context; the detached
        // runner doesn't otherwise announce itself at INFO level.
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
        return launch(args, { registry, eventQueue, runner, depth, logger, timeoutMs });
    },
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Wiring {
    registry: TaskRegistry;
    eventQueue: BackgroundEventSink;
    buildSubAgent: SubAgentFactory;
    depth: number;
    logger: SpawnBackgroundTaskConfigurable['logger'];
}

/**
 * Validate ctx.configurable. Returns the typed wiring on success, or an
 * LLM-friendly error string on failure — the tool returns that string so
 * the agent sees the problem in the tool result rather than crashing the turn.
 */
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
    },
): string {
    const { registry, eventQueue, runner, depth, logger, timeoutMs } = deps;

    const descriptionLabel =
        args.description ?? truncate(args.task, 80);

    // Prefer the teammate record — a named worker the leader may send
    // follow-up messages to once idle. This is the "persistent role"
    // model; a nameless background_job would be more ephemeral.
    const task = createTeammateTask({
        id: registry.nextId('teammate'),
        workerName: args.worker,
        description: descriptionLabel,
        depth: depth + 1,
    });

    registry.register(task);
    const running = toRunning(task);
    if (running.ok) registry.replace(running.task);

    // Signal the ChannelWorker that a task has started so it can drop a
    // ⏳ reaction on the user's triggering message and begin the typing
    // indicator loop. Zero chat-message noise — the channel's native
    // presence signals ARE the progress UX while the task runs.
    eventQueue.push({
        type: 'task_start',
        taskId: task.id,
        completedAt: Date.now(),
    });

    // Arm the ceiling timer. Fires the task's WHOLE abort controller so the
    // runner's LLM call sees signal.aborted and throws. The `finally` in
    // runInBackground clears the timer on natural completion.
    const timeoutTimer = setTimeout(() => {
        logger?.warn?.(
            { taskId: task.id, worker: args.worker, timeoutMs },
            'spawn_background_task: ceiling reached, aborting',
        );
        task.abortPair?.whole.abort();
    }, timeoutMs);

    // Detached — void Promise handle. We catch internally so we never
    // produce an unhandled rejection.
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
}): Promise<void> {
    const { taskId, registry, eventQueue, runner, logger, timeoutTimer } = args;
    const startedAt = Date.now();

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
        // Always clear the ceiling timer — whether the task finished naturally,
        // failed, or was already aborted by the timer itself.
        clearTimeout(timeoutTimer);
    }
}

function truncate(s: string, max: number): string {
    const oneLine = s.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= max) return oneLine;
    return oneLine.slice(0, max - 1).trimEnd() + '…';
}

// Re-export also for background_job variant if/when we add it — the
// ephemeral one-shot path wouldn't register as a teammate. Leaving as a
// signal for a future split.
export { createBackgroundJobTask };
