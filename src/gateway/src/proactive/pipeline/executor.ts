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
            const augmentedPrompt = contextBlock ? contextBlock + job.prompt : job.prompt;
            let response: string;
            // `structured` is populated via one of two paths:
            //  1. StructuredLLM second pass (preferred — provider-enforced JSON
            //     with up to 2 retries on validation failure)
            //  2. Post-hoc JSON extraction by agent-bridge when no
            //     structuredOutputModel is configured (legacy fallback)
            let structured: ProactiveOutput | undefined;

            try {
                const passSchemaToAgent =
                    job.deliveryMode === 'conditional' && !this.structuredOutputModel;
                const agentOptions = passSchemaToAgent
                    ? { threadId, responseSchema: proactiveOutputSchema }
                    : { threadId };
                const result = await this.agentCaller(augmentedPrompt, agentOptions);
                response = result.response;
                if (passSchemaToAgent) {
                    structured = (result as { structured?: ProactiveOutput }).structured;
                }
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
                return this.finalize(job, jobState, startedAt, 'suppressed');
            }

            // Second-pass reformatter: when a structured-output model is
            // configured, funnel the agent's free-form reply through
            // flopsygraph's StructuredLLM to produce a schema-valid
            // ProactiveOutput. This is provider-enforced + retries on
            // validation failure, so `structured.message` becomes the
            // canonical delivery content (no more post-hoc regex extraction).
            if (
                job.deliveryMode === 'conditional' &&
                this.structuredOutputModel &&
                !structured
            ) {
                structured = await this.reformatToStructured(response, job).catch((err) => {
                    log.warn(
                        { jobId: job.id, err: err instanceof Error ? err.message : String(err) },
                        'StructuredLLM reformat failed — falling back to raw response',
                    );
                    return undefined;
                });
            }

            if (job.deliveryMode === 'conditional') {
                return this.executeConditional(job, jobState, startedAt, response, structured);
            }

            const cleanResponse = stripReportedLines(response);
            return this.deliverResponse(job, jobState, startedAt, cleanResponse);
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
            await this.agentCaller(job.prompt, { threadId });
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

            if (!structured.shouldDeliver) {
                log.debug(
                    { jobId: job.id, reason: structured.reason, topics },
                    'Conditional: suppressed (structured)',
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

        // Fallback: legacy string-parsing for agents that haven't adopted JSON output
        const decision = parseConditionalResponse(response);

        if (!decision || decision.status === 'suppress') {
            const reason = decision?.reason ?? 'Agent suppressed';
            log.debug({ jobId: job.id, reason }, 'Conditional: suppressed');
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

        if (embedding) {
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

function parseConditionalResponse(text: string): ConditionalResponse | null {
    try {
        const parsed = JSON.parse(text);
        if (parsed?.status === 'promote' || parsed?.status === 'suppress') {
            return parsed as ConditionalResponse;
        }
    } catch {
        const match = text.match(/```json\s*\n([\s\S]*?)\n```/);
        if (match?.[1]) {
            try {
                const parsed = JSON.parse(match[1]);
                if (parsed?.status === 'promote' || parsed?.status === 'suppress') {
                    return parsed as ConditionalResponse;
                }
            } catch {}
        }
    }
    return null;
}
