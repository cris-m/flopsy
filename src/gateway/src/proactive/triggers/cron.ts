import { Cron } from 'croner';
import { createLogger } from '@flopsy/shared';
import type { JobExecutor } from '../pipeline/executor';
import type { StateStore } from '../state/store';
import type { JobDefinition, CronSchedule, ExecutionJob, DeliveryTarget } from '../types';
import type { PromptLoader } from '../prompt-loader';

const log = createLogger('cron');
const MAX_TIMER_DELAY_MS = 60_000;
/**
 * Grace window for past-due `at` oneshots discovered at register time
 * (matches Hermes's ONESHOT_GRACE_SECONDS = 120). Within this window we
 * fire immediately; beyond it we mark the job completed + drop from DB
 * so it doesn't linger as a phantom in `flopsy cron list`.
 */
const PAST_DUE_AT_GRACE_MS = 2 * 60 * 1_000;

export class CronTrigger {
    private jobs: Map<string, JobDefinition> = new Map();
    private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private running = false;
    /**
     * Resolves delivery at fire time. Engine injects this so
     * `followActiveChannel` routing picks up the live last-active peer.
     * Defaults to identity pass-through when unset (tests / no engine).
     */
    resolveDelivery: (override?: DeliveryTarget) => DeliveryTarget | null = (o) => o ?? null;

    /**
     * Engine-supplied callback to delete a runtime schedule row from
     * `proactive_runtime_schedules`. Invoked whenever a oneshot cron
     * completes (either fired successfully OR past-due at register) so
     * `flopsy cron list` doesn't leak phantom entries. Default no-op keeps
     * the trigger testable in isolation (no dedupStore needed).
     */
    deleteRuntimeRow: (id: string) => void = () => {};

    /**
     * Optional resolver for peer session threadIds. Engine injects this from
     * `agentHandler.resolveProactiveThreadId` when the peer+session model is
     * active. Falls back to static `job.payload.threadId` when unset.
     */
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
        // NB: static defaultDelivery is no longer stored — delivery is
        // resolved at fire time via this.resolveDelivery (set by engine).
        // The `_defaultDelivery` parameter is kept for API compatibility.

        for (const job of jobs) {
            if (!job.enabled) continue;
            // Skip one-shot cron jobs whose completion was already persisted.
            // Applies to both `kind:"cron"` + oneshot:true and `kind:"at"`
            // schedules — restarting the gateway shouldn't re-fire them.
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
            // Past-due `at` jobs would otherwise be silently dropped on
            // restart — the schedule window already closed. Two outcomes:
            //   - Within grace (≤2min late): fire NOW so a gateway restart
            //     that happens a few seconds before/during the at-time
            //     doesn't lose the fire. Matches Hermes's 120s grace.
            //   - Beyond grace: mark the job completed and delete its
            //     DB row so it stops appearing in `flopsy cron list` as
            //     an orphaned phantom. Warn-logged so operators see it.
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
                // One-shot jobs (payload.oneshot OR schedule.kind==='at')
                // fire exactly once. Persist completion + drop the DB row
                // so `flopsy cron list` doesn't show the completed job as
                // still-enabled. `completedOneshots[]` still holds the id
                // as a re-fire guard in case the row somehow gets re-added.
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
                  .resolve(job.payload.message, job.payload.promptFile)
                  .catch((err) => {
                      log.warn({ jobId: job.id, err }, 'Failed to load promptFile, using message');
                      return job.payload.message ?? '';
                  })
            : (job.payload.message ?? '');

        // Prefer the session-resolved threadId over the static payload one
        // so proactive fires land in the peer's active session. Static
        // job.payload.threadId is a hard override (e.g. a shared group thread)
        // and should only be used when the caller explicitly set it.
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
