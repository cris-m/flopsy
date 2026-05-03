import { Cron } from 'croner';
import { createLogger } from '@flopsy/shared';
import type { JobExecutor } from '../pipeline/executor';
import type { StateStore } from '../state/store';
import type { JobDefinition, CronSchedule, ExecutionJob, DeliveryTarget } from '../types';
import type { PromptLoader } from '../prompt-loader';

const log = createLogger('cron');
const MAX_TIMER_DELAY_MS = 60_000;
// Past-due `at` oneshots within this window fire immediately on register;
// beyond it they're marked complete + dropped.
const PAST_DUE_AT_GRACE_MS = 2 * 60 * 1_000;

export class CronTrigger {
    private jobs: Map<string, JobDefinition> = new Map();
    private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private running = false;
    /** Set by engine; resolves delivery per-fire. */
    resolveDelivery: (override?: DeliveryTarget) => DeliveryTarget | null = (o) => o ?? null;

    /** Engine callback to drop a runtime schedule row when oneshots complete. */
    deleteRuntimeRow: (id: string) => void = () => {};

    threadIdResolver?: (
        channelName: string,
        peer: { id: string; type: 'user' | 'group' | 'channel' },
        source: 'heartbeat' | 'cron',
    ) => string | undefined;

    constructor(
        private readonly executor: JobExecutor,
        private readonly store: StateStore,
        private readonly promptLoader?: PromptLoader,
    ) {}

    async start(jobs: JobDefinition[], _defaultDelivery?: DeliveryTarget): Promise<void> {
        if (this.running) return;
        this.running = true;

        for (const job of jobs) {
            if (!job.enabled) continue;
            if (this.isOneshot(job) && this.store.isOneshotCompleted(job.id)) {
                log.info({ jobId: job.id }, 'One-shot cron job already completed — skipping');
                continue;
            }
            this.jobs.set(job.id, job);
            try {
                await this.scheduleNext(job);
            } catch (err) {
                log.error(
                    { jobId: job.id, schedule: job.schedule, err },
                    'Failed to schedule cron job — skipping',
                );
                this.jobs.delete(job.id);
                continue;
            }
            log.info({ jobId: job.id, name: job.name }, 'Cron job registered');
        }
    }

    private isOneshot(job: JobDefinition): boolean {
        return job.payload.oneshot === true || job.schedule.kind === 'at';
    }

    async stop(): Promise<void> {
        this.running = false;
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.jobs.clear();
    }

    async addJob(job: JobDefinition): Promise<void> {
        this.jobs.set(job.id, job);
        if (job.enabled && this.running) {
            await this.scheduleNext(job);
        }
    }

    async removeJob(id: string): Promise<void> {
        this.jobs.delete(id);
        const timer = this.timers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(id);
        }
    }

    async triggerNow(id: string): Promise<boolean> {
        const job = this.jobs.get(id);
        if (!job) return false;
        await this.fire(job);
        return true;
    }

    listJobs(): JobDefinition[] {
        return [...this.jobs.values()];
    }

    private async scheduleNext(job: JobDefinition): Promise<void> {
        const nextMs = computeNextRunAtMs(job.schedule, Date.now());
        if (nextMs === undefined) {
            // Past-due `at`: fire-or-drop based on PAST_DUE_AT_GRACE_MS.
            if (job.schedule.kind === 'at') {
                const pastDueMs = Date.now() - job.schedule.atMs;
                if (pastDueMs <= PAST_DUE_AT_GRACE_MS) {
                    log.warn(
                        { jobId: job.id, pastDueMs },
                        'Past-due at-cron within grace — firing now',
                    );
                    await this.fire(job);
                } else {
                    log.warn(
                        { jobId: job.id, pastDueMs },
                        'Past-due at-cron beyond grace — marking complete',
                    );
                }
                this.store.markOneshotCompleted(job.id);
                this.jobs.delete(job.id);
                this.deleteRuntimeRow(job.id);
                return;
            }
            log.debug({ jobId: job.id }, 'No next run, job complete');
            return;
        }

        const delayMs = Math.max(0, Math.min(nextMs - Date.now(), MAX_TIMER_DELAY_MS));

        const timer = setTimeout(async () => {
            this.timers.delete(job.id);
            if (!this.running) return;

            const now = Date.now();
            if (nextMs > now) {
                await this.scheduleNext(job);
                return;
            }

            await this.fire(job);

            if (this.isOneshot(job)) {
                this.store.markOneshotCompleted(job.id);
                this.jobs.delete(job.id);
                this.deleteRuntimeRow(job.id);
                log.info({ jobId: job.id }, 'One-shot cron job completed + cleaned up');
                return;
            }

            await this.scheduleNext(job);
        }, delayMs);

        timer.unref();
        this.timers.set(job.id, timer);
    }

    private async fire(job: JobDefinition): Promise<void> {
        const delivery = this.resolveDelivery(job.payload.delivery);
        if (!delivery) {
            log.warn({ jobId: job.id }, 'No delivery target, skipping');
            return;
        }

        const prompt = this.promptLoader
            ? await this.promptLoader
                  .resolve(job.payload.message, job.payload.promptFile, 'cron')
                  .catch((err) => {
                      log.error({ jobId: job.id, err }, 'Failed to load promptFile — skipping fire');
                      return null;
                  })
            : (job.payload.message ?? '');
        if (prompt === null) return;

        // Static payload.threadId is a hard override; otherwise resolve to
        // the peer's active session via threadIdResolver.
        const resolvedThreadId =
            job.payload.threadId ??
            this.threadIdResolver?.(delivery.channelName, delivery.peer, 'cron');
        const executionJob: ExecutionJob = {
            id: job.id,
            name: job.name,
            trigger: 'cron',
            prompt,
            delivery,
            deliveryMode: job.payload.deliveryMode ?? 'always',
            ...(resolvedThreadId ? { threadId: resolvedThreadId } : {}),
        };

        await this.executor.execute(executionJob).catch((err) => {
            log.error({ jobId: job.id, err }, 'Cron job execution failed');
        });
    }
}

function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
    switch (schedule.kind) {
        case 'at':
            return schedule.atMs > nowMs ? schedule.atMs : undefined;
        case 'every': {
            const anchor = schedule.anchorMs ?? 0;
            const elapsed = nowMs - anchor;
            const next = anchor + Math.ceil(elapsed / schedule.everyMs) * schedule.everyMs;
            return next <= nowMs ? next + schedule.everyMs : next;
        }
        case 'cron': {
            const cron = new Cron(schedule.expr, { timezone: schedule.tz ?? 'UTC' });
            const next = cron.nextRun(new Date(nowMs));
            return next ? next.getTime() : undefined;
        }
        default:
            return undefined;
    }
}
