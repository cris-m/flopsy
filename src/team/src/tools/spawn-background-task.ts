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
    /**
     * Last assistant text the worker produced before failing/timing-out.
     * Surface for task_error events so the parent agent can recover useful
     * work — claude-code's extractPartialResult pattern.
     */
    readonly partialResult?: string;
}

/**
 * Error thrown by SubAgentRunner implementations when the underlying
 * sub-agent invocation fails BUT the runner was able to recover an
 * in-flight assistant text (e.g. from a checkpoint snapshot). The catch
 * block in `runInBackground` reads `.partialResult` and forwards it on
 * the task_error event.
 */
export class PartialResultError extends Error {
    readonly partialResult: string | undefined;
    readonly cause: unknown;
    constructor(cause: unknown, partialResult: string | undefined) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'PartialResultError';
        this.partialResult = partialResult;
        this.cause = cause;
    }
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
            'Teammate to delegate to — name from your team roster in the system prompt.',
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
        'Start a long-running task in the background and return immediately. A task-notification arrives when it completes; spawns run in parallel. Default timeoutMs 1800000 (30 min), max 7200000 (2 h). For work under ~2 minutes use delegate_task instead.',
        '',
        'Targets:',
        '  worker — pick from the `## Your Team` table in your system prompt (single source of truth). NEVER guess a name not listed there.',
        '',
        'Behaviour:',
        '  - suits research briefs and anything over ~2 min.',
        '  - teammate has no conversation memory — pack angles, source hints, claims to fact-check, output shape into the task string.',
        '  - workers may delegate further; max depth 3, loops blocked.',
        '  - spawn multiple in one turn when topics are independent. Don\'t serialise independent work.',
        '  - call send_message right after spawning to tell the user it started.',
        '',
        'Style (apply when the notification arrives):',
        '  - require an inline canonical URL for every non-trivial factual claim. Surface URLs when relaying; don\'t strip them.',
        '  - for multi-source briefs, ask the worker to surface contradictions rather than pick one silently.',
        '  - relay as "Worker reports X" until you have verified the claim yourself.',
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
    // The `reason` flows through to AbortSignal.reason, letting the catch block
    // distinguish a deadline-driven kill from a network failure that happens to
    // also surface as an AbortError.
    const timeoutTimer = setTimeout(() => {
        logger?.warn?.(
            { taskId: task.id, worker: args.worker, timeoutMs },
            'spawn_background_task: ceiling reached, aborting',
        );
        task.abortPair?.whole.abort({ kind: 'task_timeout', timeoutMs });
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
        const reason = aborted ? args.abortSignal.reason : undefined;
        const isTaskTimeout =
            !!reason &&
            typeof reason === 'object' &&
            (reason as { kind?: unknown }).kind === 'task_timeout';

        const status: 'failed' | 'killed' = aborted ? 'killed' : 'failed';
        const durationMs = Date.now() - startedAt;
        const isPartial = err instanceof PartialResultError;
        const partialResult = isPartial ? err.partialResult : undefined;
        const rawErr = isPartial ? err.cause : err;
        const rawMessage = rawErr instanceof Error ? rawErr.message : String(rawErr);

        // Surface a timeout-shaped message when the spawn deadline fired so the
        // main agent's wake-up turn can react to "timed out" rather than the
        // opaque "fetch aborted" surface error. Mirrors claude-code's killed-vs-
        // failed split — same data, just labeled at the source.
        let message: string;
        if (isTaskTimeout) {
            const cfgMs = (reason as { timeoutMs?: unknown }).timeoutMs;
            const cfgSec =
                typeof cfgMs === 'number' && Number.isFinite(cfgMs)
                    ? Math.round(cfgMs / 1000)
                    : undefined;
            const ranSec = Math.round(durationMs / 1000);
            message =
                cfgSec !== undefined
                    ? `Task timed out after ${ranSec}s (configured ceiling: ${cfgSec}s). Worker '${workerName}' did not return a result in time.`
                    : `Task timed out after ${ranSec}s. Worker '${workerName}' did not return a result in time.`;
        } else {
            message = rawMessage;
        }

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
            ...(partialResult ? { partialResult } : {}),
        });
        logger?.warn?.(
            {
                taskId,
                durationMs,
                err: message,
                rawErr: rawMessage,
                aborted,
                isTaskTimeout,
                partialResultChars: partialResult?.length ?? 0,
            },
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
