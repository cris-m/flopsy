import { createLogger } from '@flopsy/shared';
import type { ChannelRouter } from '../delivery/router';
import type { StateStore } from '../state/store';
import { getDefaultJobState } from '../state/store';
import type { PresenceManager } from '../state/presence';
import type { QueueManager } from '../state/queue';
import type { RetryQueue } from '../state/retry-queue';
import type {
    ExecutionJob,
    ExecutionResult,
    ConditionalResponse,
    AgentCaller,
    ThreadCleaner,
} from '../types';
import { BACKOFF_SCHEDULE_MS } from '../types';

const log = createLogger('job-executor');

export class JobExecutor {
    constructor(
        private readonly agentCaller: AgentCaller,
        private readonly threadCleaner: ThreadCleaner,
        private readonly router: ChannelRouter,
        private readonly store: StateStore,
        private readonly presence: PresenceManager,
        private readonly queue: QueueManager,
        private readonly retryQueue: RetryQueue,
    ) {}

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
            let response: string;

            try {
                const result = await this.agentCaller(job.prompt, { threadId });
                response = result.response;
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

            if (!response?.trim()) {
                return this.finalize(job, jobState, startedAt, 'suppressed');
            }

            if (job.deliveryMode === 'conditional') {
                return this.executeConditional(job, jobState, startedAt, response);
            }

            return this.deliverResponse(job, jobState, startedAt, response);
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
    ): Promise<ExecutionResult> {
        const decision = parseConditionalResponse(response);

        if (!decision || decision.status === 'suppress') {
            const reason = decision?.reason ?? 'Agent suppressed';
            log.debug({ jobId: job.id, reason }, 'Conditional: suppressed');
            await this.store.addTopic(job.name, job.id, false);
            return this.finalize(job, jobState, startedAt, 'suppressed');
        }

        const raw = decision.content ?? response;
        const content = typeof raw === 'string' ? raw.slice(0, 4000) : response;
        return this.deliverResponse(job, jobState, startedAt, content);
    }

    private async deliverResponse(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
        text: string,
    ): Promise<ExecutionResult> {
        const activity = await this.presence.getActivityWindow();

        if (activity === 'away' || activity === 'idle') {
            await this.queue.enqueue({
                content: text,
                source: job.id,
                priority: job.trigger === 'webhook' ? 10 : 5,
                delivery: job.delivery,
            });
            log.debug({ jobId: job.id, activity }, 'User away/idle, queued for later');
            return this.finalize(job, jobState, startedAt, 'queued');
        }

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
        await this.store.addTopic(job.name, job.id, true);
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
        // Not JSON — try to extract from markdown code block
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
