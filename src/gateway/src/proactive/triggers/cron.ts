import { createLogger } from '@flopsy/shared';
import type { JobExecutor } from '../pipeline/executor';
import type { JobDefinition, CronSchedule, ExecutionJob, DeliveryTarget } from '../types';

const log = createLogger('cron');
const MAX_TIMER_DELAY_MS = 60_000;

export class CronTrigger {
    private jobs: Map<string, JobDefinition> = new Map();
    private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private defaultDelivery: DeliveryTarget | null = null;
    private running = false;

    constructor(private readonly executor: JobExecutor) {}

    async start(jobs: JobDefinition[], defaultDelivery: DeliveryTarget): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.defaultDelivery = defaultDelivery;

        for (const job of jobs) {
            if (!job.enabled) continue;
            if (job.schedule.kind === 'cron') {
                log.warn(
                    { jobId: job.id, expr: job.schedule.expr },
                    'Cron expression jobs are not yet supported — job will not fire',
                );
                continue;
            }
            this.jobs.set(job.id, job);
            await this.scheduleNext(job);
            log.info({ jobId: job.id, name: job.name }, 'Cron job registered');
        }
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

            if (job.schedule.kind !== 'at') {
                await this.scheduleNext(job);
            }
        }, delayMs);

        timer.unref();
        this.timers.set(job.id, timer);
    }

    private async fire(job: JobDefinition): Promise<void> {
        const delivery = job.payload.delivery ?? this.defaultDelivery;
        if (!delivery) {
            log.warn({ jobId: job.id }, 'No delivery target, skipping');
            return;
        }

        const prompt = job.payload.message ?? '';

        const executionJob: ExecutionJob = {
            id: job.id,
            name: job.name,
            trigger: 'cron',
            prompt,
            delivery,
            deliveryMode: job.payload.deliveryMode ?? 'always',
            threadId: job.payload.threadId,
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
        case 'cron':
            // TODO: use croner library for full cron expression parsing
            // For now, return undefined — will be implemented with croner dependency
            return undefined;
        default:
            return undefined;
    }
}
