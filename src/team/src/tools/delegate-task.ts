/**
 * delegate_task — synchronous delegation to a named teammate.
 *
 * Blocks the leader's current turn until the teammate returns. Use for focused
 * sub-tasks that complete in under ~2 minutes and whose result you need
 * before you can answer the user ("summarise this before I reply",
 * "validate this JSON and tell me what's wrong"). For anything longer or
 * any task where the user shouldn't wait, use `spawn_background_task`.
 *
 * Returns the teammate's final text. On timeout / abort / failure, returns
 * a diagnostic string — never throws into the turn, so the leader stays
 * alive and can fall back to answering directly.
 *
 * Wiring contract (shared with spawn_background_task):
 *   ctx.configurable.registry       — TaskRegistry instance
 *   ctx.configurable.buildSubAgent  — SubAgentFactory
 *   ctx.configurable.depth          — 0 for main agent, 1 for teammate
 *   ctx.configurable.signal?        — parent turn's AbortSignal (optional)
 */

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

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

// Blocks the leader's turn, so it can't exceed channel-worker's
// BACKGROUND_TURN_TIMEOUT_MS (currently 15min). Keep a safety buffer.
export const DEFAULT_DELEGATE_TIMEOUT_MS = 180_000; // 3 min — typical focused sub-task
export const MAX_DELEGATE_TIMEOUT_MS = 900_000; // 15 min — cap matching retrigger turn

/** Delegate reuses spawn's configurable shape — same wiring, same factory. */
export type DelegateTaskConfigurable = Pick<
    SpawnBackgroundTaskConfigurable,
    'registry' | 'buildSubAgent' | 'depth' | 'logger'
>;

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
            'Full task description for the teammate. The teammate has no access to conversation history — include any context the teammate needs.',
        ),
    context: z
        .record(z.unknown())
        .optional()
        .describe(
            'Structured key→value context block injected before the task string. Use to pass known facts (user_email, date_range, prior_findings…) without embedding them in free-form prose. Example: { user_timezone: "Europe/Paris", target_repo: "org/repo" }.',
        ),
    outputFormat: z
        .string()
        .optional()
        .describe(
            'Describe what the response should look like: "bullet list", "JSON", "3-paragraph analysis", etc. Appended after the task string. Helps the worker produce output the leader can parse directly.',
        ),
    tools: z
        .array(z.string())
        .optional()
        .describe(
            'Optional allowlist of tool names the teammate may use. Defaults to the teammate\'s configured toolsets.',
        ),
    timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_DELEGATE_TIMEOUT_MS)
        .optional()
        .describe(
            `Soft timeout in ms. Default ${DEFAULT_DELEGATE_TIMEOUT_MS}; max ${MAX_DELEGATE_TIMEOUT_MS}. ` +
            `NEVER pass a value below 60000 — workers need time for model inference + tool calls. ` +
            `Omit this parameter unless you have a specific reason to override the default.`,
        ),
});

type DelegateArgs = z.infer<typeof schema>;

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const delegateTaskTool = defineTool({
    name: 'delegate_task',
    description: [
        'Delegate a focused sub-task to a named teammate. BLOCKS this turn until the teammate returns.',
        'Use for tasks that finish in under 2 minutes AND whose result you need before replying.',
        '',
        'Workers:',
        '  - "legolas"  — quick scout + Google Workspace. Web lookups, Gmail/Calendar/Drive/YouTube. "what\'s X?" / "read my inbox" / "any events today?"',
        '  - "saruman"  — deep researcher (multi-round, inline citations). Landscape briefs, compare angles, surface contradictions. SLOW — prefer spawn_background_task for saruman.',
        '  - "gimli"    — analysis/criticism + local notes. Pattern check, review a draft, spot flaws, Obsidian/Apple Notes/Reminders/Notion/Todoist.',
        '  - "aragorn"  — security intel. VirusTotal/Shodan lookups.',
        '  - "sam"      — media + home. Spotify playback, Home Assistant control.',
        '',
        'Pick by shape of the question, not by keyword:',
        '  Good: "summarize this doc in 5 bullets"          → legolas (short, one pass)',
        '  Good: "what emails did I get today"              → legolas (Gmail)',
        '  Good: "validate this JSON and explain errors"    → gimli (analysis)',
        '  Good: "write a note in Obsidian about X"         → gimli (local filesystem)',
        '  Avoid: "research the state of post-quantum crypto" → DO NOT use delegate (too long). Use spawn_background_task(saruman).',
        '',
        'The teammate has NO memory of this conversation — pack context into the task string.',
        'The teammate CANNOT delegate further (max depth = 1).',
        'If the user should not wait, OR the task could take >2 min: use spawn_background_task instead.',
    ].join('\n'),
    schema,
    execute: async (args, ctx) => {
        const cfg = (ctx.configurable ?? {}) as Partial<DelegateTaskConfigurable>;
        const wiring = validateWiring(cfg);
        if (typeof wiring === 'string') return wiring;

        const { registry, buildSubAgent, depth, logger } = wiring;

        // Lifecycle INFO — an operator reading logs wants to see that the
        // main agent decided to delegate, to whom, for what. Truncate task
        // text to 160 chars so the log line stays scannable.
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

        const runner = buildSubAgent(args.worker);
        if (!runner) {
            return `delegate_task: unknown worker "${args.worker}". Ensure it exists in the team and is enabled.`;
        }

        return await runInline(args, { registry, runner, depth, logger, parentSignal: ctx.signal });
    },
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Wiring {
    registry: TaskRegistry;
    buildSubAgent: SubAgentFactory;
    depth: number;
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
        logger: cfg.logger,
    };
}

/**
 * Merge structured `context` + `outputFormat` fields into the task string
 * so the worker receives a single clean prompt with no parsing guesswork.
 */
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

/**
 * Run the teammate inline. The leader's current turn stays blocked until
 * either (a) the teammate resolves, (b) the timeout fires, or (c) the
 * parent turn's AbortSignal fires. In (b) or (c), we abort the teammate's
 * whole controller so its sub-work cleans up.
 */
async function runInline(
    args: DelegateArgs,
    deps: {
        registry: TaskRegistry;
        runner: import('./spawn-background-task').SubAgentRunner;
        depth: number;
        logger: DelegateTaskConfigurable['logger'];
        parentSignal: AbortSignal | undefined;
    },
): Promise<string> {
    const { registry, runner, depth, logger, parentSignal } = deps;
    // Enforce a minimum — models sometimes pass 30s which is never enough
    // for a worker that needs model inference + tool calls.
    const MIN_DELEGATE_TIMEOUT_MS = 60_000;
    const timeoutMs = Math.max(args.timeoutMs ?? DEFAULT_DELEGATE_TIMEOUT_MS, MIN_DELEGATE_TIMEOUT_MS);

    const task = createTeammateTask({
        id: registry.nextId('teammate'),
        workerName: args.worker,
        description: args.task.slice(0, 120),
        depth: depth + 1,
    });
    registry.register(task);
    const running = toRunning(task);
    if (running.ok) registry.replace(running.task);

    const whole = task.abortPair!.whole;
    const startedAt = Date.now();

    // Link parent turn's abort → teammate's whole controller so a user
    // "stop" on the leader propagates to the delegate.
    const unlinkParent = parentSignal
        ? linkSignal(parentSignal, () => whole.abort())
        : undefined;

    // Arm the timeout.
    const timer: NodeJS.Timeout = setTimeout(() => whole.abort(), timeoutMs);

    try {
        const result = await runner({
            workerName: args.worker,
            task: buildTaskPrompt(args),
            toolAllowlist: args.tools,
            signal: whole.signal,
        });

        const done = toTerminal(task, 'completed', { result });
        if (done.ok) registry.replace(done.task);
        logger?.info?.(
            { taskId: task.id, durationMs: Date.now() - startedAt },
            'delegate_task: completed',
        );
        return result;
    } catch (err) {
        const aborted = whole.signal.aborted;
        const timedOut = aborted && Date.now() - startedAt >= timeoutMs - 100; // within jitter
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

/**
 * Register `onAbort` as a once-only listener on `signal`. Returns a cleanup
 * function that removes the listener (avoids leaks when the delegate
 * resolves before the parent aborts).
 */
function linkSignal(signal: AbortSignal, onAbort: () => void): () => void {
    if (signal.aborted) {
        onAbort();
        return () => {};
    }
    const handler = () => onAbort();
    signal.addEventListener('abort', handler, { once: true });
    return () => signal.removeEventListener('abort', handler);
}
