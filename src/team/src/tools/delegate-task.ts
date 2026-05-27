import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import { numberLooseOptional, stringArrayLooseOptional } from './schema-coerce';
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

export const DEFAULT_DELEGATE_TIMEOUT_MS = 180_000;
export const MAX_DELEGATE_TIMEOUT_MS = 480_000;

/** Subset of LearningStore that delegate_task uses to persist a run. */
export interface DelegateRunStore {
    recordDelegateRun(args: {
        taskId: string;
        threadId: string;
        workerName: string;
        taskPrompt: string;
        toolAllowlist: readonly string[] | null;
        startedAtMs: number;
        endedAtMs: number;
        status: 'completed' | 'failed' | 'killed';
        result: string | null;
        error: string | null;
    }): void;
}

export type DelegateTaskConfigurable = Pick<
    SpawnBackgroundTaskConfigurable,
    'registry' | 'buildSubAgent' | 'depth' | 'logger'
> & {
    spawnChain?: string[];
    /** Optional — when set, delegate runs land in the worker_activity ledger. */
    runStore?: DelegateRunStore;
    /** Parent thread for the run (gateway routing key). Required with runStore. */
    threadId?: string;
    onDelegationComplete?: (
        task: string,
        result: string,
        childSessionId: string,
    ) => void | Promise<void>;
};

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
            'Full task description for the teammate. The teammate has no access to conversation history — include any context the teammate needs.',
        ),
    context: z
        .record(z.unknown())
        .optional()
        .describe(
            'Structured key→value context block injected before the task string. ' +
            'Values may be strings, numbers, booleans, or ARRAYS of those — use a real ' +
            'JSON array for lists, never inline multiple bare strings. ' +
            'Example with a single value:  { "user_timezone": "Europe/Paris" }. ' +
            'Example with an array value:  { "focus_areas": ["AI", "startups", "dev tools"] }. ' +
            'Example mixed:                { "date": "2026-04-28", "topics": ["x", "y"], "max_results": 5 }. ' +
            'Use to pass known facts (user_email, date_range, prior_findings, …) without ' +
            'embedding them in free-form prose.',
        ),
    outputFormat: z
        .string()
        .optional()
        .describe(
            'Describe what the response should look like: "bullet list", "JSON", "3-paragraph analysis", etc. Appended after the task string. Helps the worker produce output the leader can parse directly.',
        ),
    tools: stringArrayLooseOptional()
        .describe(
            'Optional list of tool-name strings the teammate may use. ' +
            'Pass a JSON array (e.g. ["web_search", "web_extract"]); a bare string ' +
            'like "web_search" is also accepted and auto-wrapped. ' +
            'Defaults to the teammate\'s configured toolsets.',
        ),
    timeoutMs: numberLooseOptional()
        .pipe(z.number().int().positive().max(MAX_DELEGATE_TIMEOUT_MS).optional())
        .describe(
            `Soft timeout in ms. Default ${DEFAULT_DELEGATE_TIMEOUT_MS}; max ${MAX_DELEGATE_TIMEOUT_MS}. ` +
            `Pass as a number (e.g. 120000); a quoted string ("120000") is also accepted. ` +
            `NEVER pass a value below 60000 — workers need time for model inference + tool calls. ` +
            `Omit this parameter unless you have a specific reason to override the default.`,
        ),
});

// Override `tools`/`timeoutMs` so consumers see the post-coercion shape.
type DelegateArgs = Omit<z.infer<typeof schema>, 'tools' | 'timeoutMs'> & {
    tools?: string[];
    timeoutMs?: number;
};

export const delegateTaskTool = defineTool({
    name: 'delegate_task',
    description: [
        'Delegate a focused sub-task to a named teammate and block until the result returns. Default timeoutMs 180000, max 480000. For work over ~2 minutes use spawn_background_task instead.',
        '',
        'Targets:',
        '  worker — pick from the `## Your Team` table in your system prompt (single source of truth). NEVER guess a name not listed there.',
        '',
        'Behaviour:',
        '  - teammate has no conversation memory — pack required context into the task string.',
        '  - workers may delegate further; max depth 3, loops blocked.',
        '  - emit multiple delegate_task calls in one assistant turn to run them in parallel. Don\'t serialise independent delegations.',
        '  - for 5+ similar items to the same worker, call parallel_map() inside execute_code({use_tools: true}).',
        '  - replies >1.5 KB auto-save to disk; the handoff returns an absolute path. Pass it verbatim to read_file for the full text.',
        '',
        'Style:',
        '  - require verifiable handles (URL, message_id, file path, HTTP status) for any external claim or side effect. No handle → treat as uncited.',
        '  - relay as "Worker reports X" until you have seen the evidence. Verify before confirming high-stakes actions.',
        '',
        'On error: timeout → race a second worker on the same task. Wrong or partial → retry once with a tighter prompt. After two failures, surface what you tried.',
    ].join('\n'),
    schema,
    execute: async (args, ctx) => {
        const cfg = (ctx.configurable ?? {}) as Partial<DelegateTaskConfigurable>;
        const wiring = validateWiring(cfg);
        if (typeof wiring === 'string') return wiring;

        const { registry, buildSubAgent, depth, logger } = wiring;
        const chain = cfg.spawnChain ?? [];

        const taskPreview = args.task.length > 160
            ? args.task.slice(0, 157) + '…'
            : args.task;
        logger?.info?.(
            {
                op: 'delegate_task',
                worker: args.worker,
                depth,
                timeoutMs: args.timeoutMs,
                taskPreview,
            },
            'delegate_task invoked',
        );

        if (depth >= MAX_DELEGATION_DEPTH) {
            return `delegate_task: max delegation depth (${MAX_DELEGATION_DEPTH}) reached. Handle this task directly.`;
        }

        if (chain.includes(args.worker)) {
            return `delegate_task: loop detected — ${args.worker} already in chain [${chain.join(' → ')}]. Handle directly.`;
        }

        const runner = buildSubAgent(args.worker);
        if (!runner) {
            return `delegate_task: unknown worker "${args.worker}". Ensure it exists in the team and is enabled.`;
        }

        const coerced = args as unknown as DelegateArgs;
        return await runInline(coerced, {
            registry,
            runner,
            depth,
            chain,
            logger,
            parentSignal: ctx.signal,
            runStore: cfg.runStore,
            threadId: cfg.threadId,
            onDelegationComplete: cfg.onDelegationComplete,
        });
    },
});

interface Wiring {
    registry: TaskRegistry;
    buildSubAgent: SubAgentFactory;
    depth: number;
    chain: string[];
    logger: DelegateTaskConfigurable['logger'];
}

function validateWiring(cfg: Partial<DelegateTaskConfigurable>): Wiring | string {
    if (!cfg.registry) {
        return 'delegate_task: no TaskRegistry configured. This tool must be invoked inside a TeamHandler-managed turn.';
    }
    if (typeof cfg.buildSubAgent !== 'function') {
        return 'delegate_task: no buildSubAgent factory configured.';
    }
    return {
        registry: cfg.registry,
        buildSubAgent: cfg.buildSubAgent,
        depth: cfg.depth ?? 0,
        chain: cfg.spawnChain ?? [],
        logger: cfg.logger,
    };
}

/** Deterministic detector for "I couldn't access X" / empty body / dropout. */
const DROPOUT_PATTERNS: readonly RegExp[] = [
    /\bi (?:can(?:not|'t)|could ?not|am unable to|don'?t have access)/i,
    /\bno (?:results?|data|response|access) (?:found|available|returned)/i,
    /\bunable to (?:access|reach|fetch|retrieve)/i,
    /\b(?:returned|got) (?:nothing|no results?|empty)/i,
];

function detectDropout(result: string): string | null {
    const body = result.trim();
    if (body.length === 0) return 'empty body';
    if (body.length < 40) {
        for (const re of DROPOUT_PATTERNS) {
            if (re.test(body)) return 'short dropout response';
        }
    } else {
        const head = body.slice(0, 400);
        for (const re of DROPOUT_PATTERNS) {
            if (re.test(head)) return 'worker reported it could not complete';
        }
    }
    return null;
}

function appendGapMarker(result: string, gap: string, worker: string): string {
    return `${result}\n\n[delegate_task:gap worker=${worker} reason="${gap}"]\nThe worker did not deliver actionable output. Either retry with a tighter prompt, route to a different worker, or flag this gap in your user-facing reply.`;
}

function buildTaskPrompt(args: DelegateArgs): string {
    const parts: string[] = [args.task];
    if (args.context && Object.keys(args.context).length > 0) {
        const lines = Object.entries(args.context)
            .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
            .join('\n');
        parts.push(`\nContext:\n${lines}`);
    }
    if (args.outputFormat) {
        parts.push(`\nRespond as: ${args.outputFormat}`);
    }
    return parts.join('');
}

async function runInline(
    args: DelegateArgs,
    deps: {
        registry: TaskRegistry;
        runner: import('./spawn-background-task').SubAgentRunner;
        depth: number;
        chain: string[];
        logger: DelegateTaskConfigurable['logger'];
        parentSignal: AbortSignal | undefined;
        runStore: DelegateRunStore | undefined;
        threadId: string | undefined;
        onDelegationComplete: DelegateTaskConfigurable['onDelegationComplete'];
    },
): Promise<string> {
    const { registry, runner, depth, chain, logger, parentSignal, runStore, threadId, onDelegationComplete } = deps;
    const timeoutMs = args.timeoutMs ?? DEFAULT_DELEGATE_TIMEOUT_MS;

    const task = createTeammateTask({
        id: registry.nextId('teammate'),
        workerName: args.worker,
        description: args.task.slice(0, 120),
        depth: depth + 1,
        spawnChain: [...chain, args.worker],
    });
    registry.register(task);
    const running = toRunning(task);
    if (running.ok) registry.replace(running.task);

    const whole = task.abortPair!.whole;
    const startedAt = Date.now();

    const unlinkParent = parentSignal
        ? linkSignal(parentSignal, () => whole.abort())
        : undefined;

    const timer: NodeJS.Timeout = setTimeout(() => whole.abort(), timeoutMs);

    const persist = (status: 'completed' | 'failed' | 'killed', result: string | null, error: string | null): void => {
        if (!runStore || !threadId) return;
        try {
            runStore.recordDelegateRun({
                taskId: task.id,
                threadId,
                workerName: args.worker,
                taskPrompt: args.task,
                toolAllowlist: args.tools ?? null,
                startedAtMs: startedAt,
                endedAtMs: Date.now(),
                status,
                result,
                error,
            });
        } catch (err) {
            logger?.warn?.({ err, taskId: task.id }, 'delegate_task: telemetry write failed (non-fatal)');
        }
    };

    try {
        const result = await runner({
            workerName: args.worker,
            task: buildTaskPrompt(args),
            toolAllowlist: args.tools,
            signal: whole.signal,
            depth: depth + 1,
            spawnChain: [...chain, args.worker],
        });

        const done = toTerminal(task, 'completed', { result });
        if (done.ok) registry.replace(done.task);
        logger?.info?.(
            { taskId: task.id, durationMs: Date.now() - startedAt },
            'delegate_task: completed',
        );

        const gap = detectDropout(result);
        if (gap) {
            logger?.warn?.(
                { taskId: task.id, worker: args.worker, gap },
                'delegate_task: worker dropout detected — annotating reply for leader',
            );
            const augmented = appendGapMarker(result, gap, args.worker);
            persist('completed', augmented, null);
            if (onDelegationComplete) {
                try { await onDelegationComplete(args.task, augmented, task.id); } catch { /* */ }
            }
            return augmented;
        }

        persist('completed', result, null);
        if (onDelegationComplete) {
            try { await onDelegationComplete(args.task, result, task.id); } catch { /* */ }
        }
        return result;
    } catch (err) {
        const aborted = whole.signal.aborted;
        const timedOut = aborted && Date.now() - startedAt >= timeoutMs - 100;
        const parentStop = aborted && parentSignal?.aborted === true;
        const message = err instanceof Error ? err.message : String(err);

        const terminal = toTerminal(task, aborted ? 'killed' : 'failed', {
            error: message,
        });
        if (terminal.ok) registry.replace(terminal.task);

        logger?.warn?.(
            {
                taskId: task.id,
                durationMs: Date.now() - startedAt,
                aborted,
                timedOut,
                parentStop,
                err: message,
            },
            'delegate_task: aborted or failed',
        );

        persist(aborted ? 'killed' : 'failed', null, message);

        if (timedOut) {
            return `delegate_task: timed out after ${timeoutMs}ms (worker=${args.worker}). The teammate was aborted.`;
        }
        if (parentStop) {
            return `delegate_task: parent turn stopped; teammate aborted.`;
        }
        if (aborted) {
            return `delegate_task: teammate aborted before completion (worker=${args.worker}).`;
        }
        return `delegate_task: failed (worker=${args.worker}): ${message}`;
    } finally {
        clearTimeout(timer);
        unlinkParent?.();
    }
}

function linkSignal(signal: AbortSignal, onAbort: () => void): () => void {
    if (signal.aborted) {
        onAbort();
        return () => {};
    }
    const handler = () => onAbort();
    signal.addEventListener('abort', handler, { once: true });
    return () => signal.removeEventListener('abort', handler);
}
