import { z } from 'zod';
import { createLogger } from '@flopsy/shared';
import { structuredLLM, type BaseChatModel } from 'flopsygraph';
import type { ChannelRouter } from '../delivery/router';
import type { StateStore } from '../state/store';
import { getDefaultJobState } from '../state/store';
import type { PresenceManager } from '../state/presence';
import type { RetryQueue } from '../state/retry-queue';
import type {
    ExecutionJob,
    ExecutionResult,
    ConditionalResponse,
    AgentCaller,
    ThreadCleaner,
} from '../types';
import { BACKOFF_SCHEDULE_MS } from '../types';
import type { ProactiveDedupStore } from '../state/dedup-store';
import type { ProactiveEmbedder } from '../engine';
import {
    buildAntiRepetitionContext,
    parseReportedLines,
    stripReportedLines,
} from './context';

/**
 * Inject real date/time/timezone so the agent never has to guess.
 * This is a `<fire_context>` block prepended to EVERY proactive prompt.
 * For jobs that need more (weather, calendar), this is the seed; the agent
 * uses its tools to gather the rest.
 */
function buildDateContext(): string {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const date = now.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz,
    });
    const time = now.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
    });
    return `<fire_context>\ndate: ${date}\ntime: ${time}\ntimezone: ${tz}\n</fire_context>\n\n`;
}

/**
 * Injects output-quality guidance and recent conversation topics so the
 * proactive agent produces specific, actionable notifications rather than
 * generic filler.
 */
function buildQualityGuidance(store: StateStore): string {
    const recentTopics = store.getRecentTopics().slice(0, 8);
    const lines = [
        '<output_quality>',
        'A good proactive notification is:',
        '  - Specific: mentions concrete names, numbers, or dates — not vague summaries',
        '  - Actionable: the user can act on it immediately (reply, check, schedule)',
        '  - Concise: 1-3 sentences for most messages; longer only when complexity demands it',
        '  - Timely: lead with what changed or is due, not with background',
        '',
        'Anti-patterns to avoid:',
        '  - Opening with "Just wanted to let you know…" or "I noticed that…"',
        '  - Restating what the user already knows',
        '  - Padding with caveats and hedges instead of the actual information',
    ];
    if (recentTopics.length > 0) {
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const t of recentTopics) {
            if (t.topic && !seen.has(t.topic)) {
                seen.add(t.topic);
                unique.push(t.topic);
            }
        }
        if (unique.length > 0) {
            lines.push('');
            lines.push('Recent topics already covered (avoid repetition):');
            for (const topic of unique.slice(0, 6)) {
                lines.push(`  - ${topic}`);
            }
        }
    }
    lines.push('</output_quality>');
    return lines.join('\n') + '\n\n';
}

const reportedIdsSchema = z.object({
    emails: z.array(z.string()).optional(),
    meetings: z.array(z.string()).optional(),
    tasks: z.array(z.string()).optional(),
    news: z.array(z.string()).optional(),
});

const proactiveOutputSchema = z.object({
    shouldDeliver: z.boolean(),
    message: z.string(),
    reason: z.string(),
    topics: z.array(z.string()).optional(),
    reportedIds: reportedIdsSchema.optional(),
    actions: z.array(z.string()).optional(),
    /**
     * Voice overlay the agent's mode-picker chose for this fire. Must
     * match a key in personalities.yaml, or be `null` (default voice).
     * Smart-pulse maps mode → overlay deterministically (e.g. initiative→
     * playful, focus→concise). Captured here so the executor:
     *   - records the choice in JobState.lastChosenOverlay for /status
     *     observability + JSONL pulse-decisions audit trail
     *   - propagates it to job.personality on the agent's NEXT call within
     *     the same fire (when the proactive flow has a follow-up turn)
     * The agent ALSO self-applies the overlay rules in its current turn
     * by reading personalities.yaml inline — see smart-pulse.md:207. This
     * field is the runtime's view of that choice.
     */
    overlay: z.string().nullable().optional(),
});

type ProactiveOutput = z.infer<typeof proactiveOutputSchema>;

export interface JobExecutorOptions {
    embedder?: ProactiveEmbedder;
    /**
     * Raw chat model (typed `unknown` at the engine boundary, cast to
     * BaseChatModel here) for flopsygraph's `structuredLLM()` reformatter.
     * When present, conditional-mode replies are funneled through provider-
     * enforced structured output with built-in retry.
     */
    structuredOutputModel?: unknown;
    similarityThreshold: number;
    similarityWindowMs: number;
}

const log = createLogger('job-executor');

export class JobExecutor {
    private readonly embedder?: ProactiveEmbedder;
    private readonly structuredOutputModel?: BaseChatModel;
    private readonly similarityThreshold: number;
    private readonly similarityWindowMs: number;

    constructor(
        private readonly agentCaller: AgentCaller,
        private readonly threadCleaner: ThreadCleaner,
        private readonly router: ChannelRouter,
        private readonly store: StateStore,
        private readonly dedupStore: ProactiveDedupStore,
        private readonly presence: PresenceManager,
        private readonly retryQueue: RetryQueue,
        options: JobExecutorOptions,
    ) {
        if (options.embedder) this.embedder = options.embedder;
        if (options.structuredOutputModel) {
            this.structuredOutputModel = options.structuredOutputModel as BaseChatModel;
        }
        this.similarityThreshold = options.similarityThreshold;
        this.similarityWindowMs = options.similarityWindowMs;
    }

    async execute(job: ExecutionJob): Promise<ExecutionResult> {
        const startedAt = Date.now();
        const jobState = await this.store.getJobState(job.id);

        if (jobState.isExecuting) {
            log.warn({ jobId: job.id }, 'Job already executing, skipping');
            return { action: 'suppressed', durationMs: 0 };
        }

        log.info(
            { jobId: job.id, name: job.name, trigger: job.trigger, deliveryMode: job.deliveryMode },
            'executing job',
        );

        jobState.isExecuting = true;
        await this.store.setJobState(job.id, jobState);

        try {
            const suppressCheck = await this.presence.shouldSuppress();
            if (suppressCheck.suppress && job.deliveryMode !== 'silent') {
                log.info({ jobId: job.id, reason: suppressCheck.reason }, 'suppressed by presence');
                return this.finalize(job, jobState, startedAt, 'suppressed');
            }

            if (job.deliveryMode === 'silent') {
                log.debug({ jobId: job.id }, 'executing in silent mode');
                return this.executeSilent(job, jobState, startedAt);
            }

            const threadId = job.threadId ?? `proactive:${job.id}:${Date.now()}`;
            const contextBlock = buildAntiRepetitionContext(this.store, this.dedupStore);
            const dateContext = buildDateContext();
            const qualityBlock = buildQualityGuidance(this.store);
            const augmentedPrompt =
                dateContext +
                qualityBlock +
                (contextBlock ? contextBlock + job.prompt : job.prompt);
            let response: string;
            // `structured` is populated via one of two paths:
            //  1. StructuredLLM second pass (preferred — provider-enforced JSON
            //     with up to 2 retries on validation failure)
            //  2. Post-hoc JSON extraction by agent-bridge when no
            //     structuredOutputModel is configured (legacy fallback)
            let structured: ProactiveOutput | undefined;

            try {
                // Schema is ALWAYS passed for proactive (heartbeat/cron/webhook).
                // Provider-enforced structured output is the contract; the
                // separate `structuredOutputModel` reformatter below is only a
                // fallback when the agent's primary structured emit failed.
                const agentOptions = {
                    threadId,
                    responseSchema: proactiveOutputSchema,
                    ...(job.personality ? { personality: job.personality } : {}),
                    ...(job.useTeamAgent ? { useTeamAgent: true as const } : {}),
                };
                const result = await this.agentCaller(augmentedPrompt, agentOptions);
                response = result.response;
                structured = (result as { structured?: ProactiveOutput }).structured;

                // Visibility: log every primary agent return so we can see in
                // gateway.out.log whether structured output is firing and what
                // it says. Truncated previews keep log line size bounded.
                log.info(
                    {
                        jobId: job.id,
                        threadId,
                        deliveryMode: job.deliveryMode,
                        structuredPresent: !!structured,
                        structuredMessagePreview: structured?.message?.slice(0, 200) ?? null,
                        structuredShouldDeliver: structured?.shouldDeliver ?? null,
                        structuredOverlay: structured?.overlay ?? null,
                        structuredTopicCount: structured?.topics?.length ?? 0,
                        responsePreview: response?.slice(0, 200) ?? '',
                        responseLength: response?.length ?? 0,
                    },
                    'agent returned (primary call)',
                );
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                log.error({ jobId: job.id, threadId, err }, 'Agent call failed');
                return this.finalizeError(job, jobState, startedAt, error);
            } finally {
                if (!job.threadId) {
                    await this.threadCleaner(threadId).catch((cleanupErr: unknown) => {
                        log.warn(
                            { err: cleanupErr, jobId: job.id, threadId, op: 'threadCleaner' },
                            'ephemeral thread cleanup failed — potential memory leak',
                        );
                    });
                }
            }

            // Track REPORTED: IDs from raw response regardless of mode — the
            // agent may emit them even in `always` mode. Fire-and-forget since
            // tracking failures must not suppress delivery.
            this.recordReportedFromText(response, job).catch((err) =>
                log.debug({ err, jobId: job.id }, 'REPORTED: parse failed'),
            );

            if (!response?.trim()) {
                log.warn(
                    { jobId: job.id, deliveryMode: job.deliveryMode, name: job.name },
                    'agent returned empty response — suppressing (check model timeout or prompt issues)',
                );
                return this.finalize(job, jobState, startedAt, 'suppressed');
            }

            // Fallback reformatter: schema is always passed to the agent, so
            // `structured` is normally populated by the primary call. This
            // path only fires when provider-enforced structured output failed
            // (rare — usually a tool-loop emitting prose). When a separate
            // `structuredOutputModel` is configured, funnel the free-form
            // reply through flopsygraph's StructuredLLM to recover.
            if (this.structuredOutputModel && !structured) {
                log.info(
                    { jobId: job.id, responsePreview: response?.slice(0, 200) },
                    'reformatter: primary call had no structured output, attempting StructuredLLM reformat',
                );
                structured = await this.reformatToStructured(response, job).catch((err) => {
                    log.warn(
                        { jobId: job.id, err: err instanceof Error ? err.message : String(err) },
                        'StructuredLLM reformat failed — falling back to raw response',
                    );
                    return undefined;
                });
                log.info(
                    {
                        jobId: job.id,
                        reformatterSuccess: !!structured,
                        reformatterMessagePreview: structured?.message?.slice(0, 200) ?? null,
                    },
                    'reformatter result',
                );
            }

            if (job.deliveryMode === 'conditional') {
                return this.executeConditional(job, jobState, startedAt, response, structured);
            }

            // Prefer the schema-validated `structured.message` (always mode
            // gets the same structured-output guarantee as conditional now).
            // Fall back to stripped raw response only when structured emit
            // failed both the primary call and the reformatter.
            const deliveryText = structured?.message
                ? structured.message
                : stripReportedLines(response);
            log.info(
                {
                    jobId: job.id,
                    deliverySource: structured?.message ? 'structured.message' : 'raw response',
                    deliveryTextPreview: deliveryText.slice(0, 200),
                    deliveryTextLength: deliveryText.length,
                },
                'delivering (always mode)',
            );
            return this.deliverResponse(job, jobState, startedAt, deliveryText);
        } finally {
            jobState.isExecuting = false;
            await this.store.setJobState(job.id, jobState);
        }
    }

    private async executeSilent(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
    ): Promise<ExecutionResult> {
        const threadId = job.threadId ?? `proactive:${job.id}:${Date.now()}`;
        try {
            await this.agentCaller(job.prompt, {
                threadId,
                ...(job.personality ? { personality: job.personality } : {}),
            });
            return this.finalize(job, jobState, startedAt, 'suppressed');
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return this.finalizeError(job, jobState, startedAt, error);
        } finally {
            if (!job.threadId) {
                await this.threadCleaner(threadId).catch((cleanupErr: unknown) => {
                    log.warn(
                        { err: cleanupErr, jobId: job.id, threadId, op: 'threadCleaner:silent' },
                        'silent-mode ephemeral thread cleanup failed',
                    );
                });
            }
        }
    }

    private async executeConditional(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
        response: string,
        structured?: ProactiveOutput,
    ): Promise<ExecutionResult> {
        if (structured) {
            const topics = structured.topics ?? [];
            if (structured.reportedIds) {
                this.recordReportedIds(structured.reportedIds, job.id);
            }

            // Record the picker's overlay choice. Used by /status to surface
            // which voice the agent picked, and by JSONL audit trail
            // (.flopsy/proactive/pulse-decisions/<date>.jsonl) so we can
            // verify mode→overlay mapping is firing as intended. The agent
            // self-applies the overlay rules in its CURRENT turn via the
            // smart-pulse prompt's inline instructions (see smart-pulse.md
            // step 4); this field is the runtime's parallel record of the
            // choice — not a re-application path.
            if (structured.overlay !== undefined) {
                jobState.lastChosenOverlay = structured.overlay ?? null;
                log.debug(
                    { jobId: job.id, overlay: structured.overlay },
                    'Conditional: picker chose overlay',
                );
            }

            if (!structured.shouldDeliver) {
                // Promoted from debug → info: this is the #1 cause of silent
                // proactive non-delivery. Operators need to see the agent's
                // own reason without enabling debug-level logging in prod.
                log.info(
                    {
                        jobId: job.id,
                        name: job.name,
                        agentReason: structured.reason,
                        topics,
                        // Snippet of the message the agent decided NOT to
                        // send — useful when reviewing whether the suppress
                        // call was actually correct.
                        suppressedMessagePreview: structured.message?.slice(0, 200) ?? null,
                        overlay: structured.overlay ?? null,
                    },
                    'Conditional: agent chose shouldDeliver=false (suppressed)',
                );
                for (const t of topics) {
                    await this.store.addTopic(t, job.id, false);
                }
                if (topics.length === 0) {
                    await this.store.addTopic(job.name, job.id, false);
                }
                return this.finalize(job, jobState, startedAt, 'suppressed');
            }

            for (const t of topics) {
                await this.store.addTopic(t, job.id, true);
            }
            return this.deliverResponse(
                job,
                jobState,
                startedAt,
                stripReportedLines(structured.message).slice(0, 4000),
            );
        }

        // Fallback: legacy string-parsing for agents that haven't adopted JSON output.
        // Reaching this branch means structured-output parsing FAILED (the
        // agent-bridge already emitted a 'MALFORMED structured output' WARN).
        // We keep going with raw text in case the agent inlined a status
        // tag like `status: promote` somewhere in the body.
        const decision = parseConditionalResponse(response);

        if (!decision || decision.status === 'suppress') {
            const reason = decision?.reason ?? 'Agent suppressed (no parseable status)';
            // Promoted from debug → info. When `decision === null`, the raw
            // response was unparseable as either JSON or `status:` tag —
            // include a preview so operators can see what the agent emitted.
            log.info(
                {
                    jobId: job.id,
                    name: job.name,
                    parseStatus: decision === null ? 'unparseable' : 'status=suppress',
                    reason,
                    responseLength: response.length,
                    responsePreview: decision === null ? response.slice(0, 400) : null,
                },
                'Conditional: suppressed (fallback string-parse path)',
            );
            await this.store.addTopic(job.name, job.id, false);
            return this.finalize(job, jobState, startedAt, 'suppressed');
        }

        const raw = decision.content ?? response;
        const content = typeof raw === 'string' ? raw.slice(0, 4000) : response;
        return this.deliverResponse(job, jobState, startedAt, stripReportedLines(content));
    }

    /**
     * Run the agent's free-form reply through flopsygraph's StructuredLLM
     * using a raw BaseChatModel + the ProactiveOutput schema. This is a
     * cheap second-pass ("reformatter") — the model doesn't re-reason or
     * re-fetch, it just coerces the prior text into structured JSON.
     *
     * Throws if the model fails to produce valid output after retries.
     */
    private async reformatToStructured(
        rawResponse: string,
        job: ExecutionJob,
    ): Promise<ProactiveOutput> {
        const llm = structuredLLM(this.structuredOutputModel!, proactiveOutputSchema);
        log.debug(
            { jobId: job.id, rawResponsePreview: rawResponse.slice(0, 200) },
            'Reformatting raw response through StructuredLLM',
        );
        const systemPrompt =
            `You are a formatter. The agent reply below came from a scheduled ` +
            `proactive job named "${job.name}". Convert it into the target JSON schema:\n\n` +
            `  - shouldDeliver: true if this is genuinely worth sending to the user now, false if nothing useful/new.\n` +
            `  - message: the text to send (faithful to the agent's content, trimmed of meta).\n` +
            `  - reason: one short sentence on why you chose shouldDeliver.\n` +
            `  - topics: 1–4 short semantic tags (e.g. ["weather","stocks"]) so future runs know what was covered.\n` +
            `  - reportedIds: any stable IDs mentioned (emails, meetings, tasks, news URLs) so they won't be re-reported.\n\n` +
            `Do not re-reason. Preserve facts exactly as the agent wrote them.`;
        const result = await llm.invoke([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: rawResponse },
        ]);
        if (!result.ok) {
            throw new Error(
                `StructuredLLM failed after ${result.attempts} attempt(s): ${result.error.message}`,
            );
        }
        return result.value;
    }

    private recordReportedIds(
        reportedIds: NonNullable<ProactiveOutput['reportedIds']>,
        source: string,
    ): void {
        for (const type of ['emails', 'meetings', 'tasks', 'news'] as const) {
            const ids = reportedIds[type];
            if (ids && ids.length > 0) {
                this.dedupStore.markReported(type, ids, source);
            }
        }
    }

    private async recordReportedFromText(text: string, job: ExecutionJob): Promise<void> {
        const parsed = parseReportedLines(text, job.name);
        for (const type of ['emails', 'meetings', 'tasks', 'news'] as const) {
            if (parsed[type].length > 0) {
                this.dedupStore.markReported(type, parsed[type], job.id);
            }
        }
    }

    private async deliverResponse(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
        text: string,
    ): Promise<ExecutionResult> {
        let embedding: number[] | undefined;
        if (this.embedder) {
            try {
                embedding = await this.embedder.embed(text);
            } catch (err) {
                log.warn({ jobId: job.id, err }, 'embedder failed — skipping similarity dedup');
            }
        }

        // Similarity dedup is skipped for 'always' mode — that delivery contract
        // means the job MUST fire on every tick. Dedup still runs for 'conditional'
        // to prevent agent-promoted duplicates from spamming.
        if (embedding && job.deliveryMode !== 'always') {
            const match = this.dedupStore.findSimilar(
                embedding,
                this.similarityThreshold,
                this.similarityWindowMs,
            );
            if (match) {
                log.info(
                    {
                        jobId: job.id,
                        similarity: match.similarity.toFixed(3),
                        matchedSource: match.source,
                        agoMs: Date.now() - match.deliveredAt,
                    },
                    'Suppressed — semantically similar delivery within window',
                );
                return this.finalize(job, jobState, startedAt, 'suppressed');
            }
        }

        // Fire-and-deliver. No activity-window queueing — the only gate
        // is explicit user intent (DND / quiet hours) already checked at
        // executor.ts:102. This matches Hermes's cron semantics and
        // sidesteps the queue-flood risk of holding messages through an
        // away window (user returns → 15 pings at once = worse UX than
        // just delivering them as they happen). Transport failures are
        // still caught below and land in the retry queue with backoff.

        const result = await this.router.deliver(job.delivery, text);

        if (!result.delivered) {
            await this.retryQueue.add({
                id: `retry_${job.id}_${Date.now()}`,
                type: 'job',
                job: {
                    id: job.id,
                    name: job.name,
                    trigger: job.trigger,
                    prompt: job.prompt,
                    delivery: job.delivery,
                    deliveryMode: job.deliveryMode,
                },
            });
            return this.finalizeError(job, jobState, startedAt, result.error ?? 'Delivery failed');
        }

        await this.store.addDelivery(text, job.id);
        this.dedupStore.recordDelivery(job.id, text, embedding);
        return this.finalize(job, jobState, startedAt, 'delivered');
    }

    private async finalize(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
        action: ExecutionResult['action'],
    ): Promise<ExecutionResult> {
        const durationMs = Date.now() - startedAt;

        jobState.lastRunAt = Date.now();
        jobState.lastStatusAt = Date.now();
        jobState.lastStatus = 'success';
        jobState.lastAction = action;
        jobState.lastError = undefined;
        jobState.runCount++;
        jobState.consecutiveErrors = 0;
        jobState.nextBackoffMs = undefined;

        if (action === 'delivered') jobState.deliveredCount++;
        if (action === 'suppressed') jobState.suppressedCount++;
        if (action === 'queued') jobState.queuedCount++;

        await this.store.setJobState(job.id, jobState);

        const level = action === 'delivered' ? 'info' : 'debug';
        log[level](
            {
                jobId: job.id,
                name: job.name,
                trigger: job.trigger,
                action,
                durationMs,
                runCount: jobState.runCount,
            },
            `job ${action}`,
        );

        return { action, durationMs };
    }

    private async finalizeError(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
        error: string,
    ): Promise<ExecutionResult> {
        const durationMs = Date.now() - startedAt;

        jobState.lastRunAt = Date.now();
        jobState.lastStatusAt = Date.now();
        jobState.lastStatus = 'error';
        jobState.lastAction = 'error';
        jobState.lastError = error;
        jobState.runCount++;
        jobState.consecutiveErrors++;

        const backoffIdx = Math.min(jobState.consecutiveErrors - 1, BACKOFF_SCHEDULE_MS.length - 1);
        jobState.nextBackoffMs = BACKOFF_SCHEDULE_MS[Math.max(0, backoffIdx)];

        await this.store.setJobState(job.id, jobState);

        log.error({ jobId: job.id, error, consecutive: jobState.consecutiveErrors }, 'Job failed');

        return { action: 'error', error, durationMs };
    }
}

/**
 * Parse a conditional-mode agent response into a structured decision.
 *
 * Accepts THREE shapes the agent may emit:
 *   1. Modern: `{shouldDeliver: bool, message?, reason?, topics?}` — what
 *      smart-pulse.md and the structured-output schema produce.
 *   2. Legacy: `{status: 'promote'|'suppress', reason, content?}`.
 *   3. Either of the above wrapped in ```json fences, ``` plain fences, or
 *      `single backticks` (DeepSeek and a few smaller models lean toward
 *      single-backtick wrapping even when the prompt says raw).
 *
 * Returns null only when nothing parses — callers treat null as
 * "fall back to suppress" so a malformed reply never accidentally fires
 * a delivery.
 */
export function parseConditionalResponse(text: string): ConditionalResponse | null {
    // Try every candidate JSON region we can extract.
    for (const candidate of extractJsonCandidates(text)) {
        const adapted = tryParseEither(candidate);
        if (adapted) return adapted;
    }
    return null;
}

/**
 * Yield every plausible JSON substring of the agent's response, ordered
 * most-likely first: raw, triple-backtick fence, single-backtick wrap,
 * first balanced `{...}` slice.
 */
function* extractJsonCandidates(text: string): IterableIterator<string> {
    const trimmed = text.trim();
    yield trimmed;

    const tripleFence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (tripleFence?.[1]) yield tripleFence[1].trim();

    // Single-backtick wrap: `{"shouldDeliver":true,...}`
    const singleBacktick = trimmed.match(/^`(.+)`$/s);
    if (singleBacktick?.[1]) yield singleBacktick[1].trim();

    // Fallback: greedy match of the outermost {...} so prose preambles
    // ("Here's the JSON: { ... }") still parse.
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        yield trimmed.slice(firstBrace, lastBrace + 1);
    }
}

/**
 * Try parsing one candidate as either the modern or legacy shape and
 * return a `ConditionalResponse` if it works.
 */
function tryParseEither(jsonText: string): ConditionalResponse | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;

    // Modern shape: {shouldDeliver, message?, reason?, topics?}
    if (typeof obj.shouldDeliver === 'boolean') {
        const reason = typeof obj.reason === 'string' ? obj.reason : '';
        const message = typeof obj.message === 'string' ? obj.message : undefined;
        return obj.shouldDeliver
            ? { status: 'promote', reason, ...(message !== undefined ? { content: message } : {}) }
            : { status: 'suppress', reason };
    }

    // Legacy shape: {status: 'promote'|'suppress', reason, content?}
    if (obj.status === 'promote' || obj.status === 'suppress') {
        const reason = typeof obj.reason === 'string' ? obj.reason : '';
        const content = typeof obj.content === 'string' ? obj.content : undefined;
        return content !== undefined
            ? { status: obj.status, reason, content }
            : { status: obj.status, reason };
    }

    return null;
}
