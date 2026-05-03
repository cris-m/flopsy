import { Cron } from 'croner';
import { createLogger } from '@flopsy/shared';
import type { CronTrigger } from '../triggers/cron';
import type { StateStore } from '../state/store';
import type { JobDefinition } from '../types';

const log = createLogger('cron-sweeper');

// Stale = lastRunAt > tolerance × period behind expected. 5min floor
// prevents thrashing on minutely crons; 1.5× absorbs benign clock skew.
const DEFAULT_TOLERANCE_MULTIPLIER = 1.5;
const DEFAULT_MIN_GRACE_MS = 5 * 60 * 1000;

export interface CronHealthCheck {
    id: string;
    name: string;
    /** Cron expression for human-readable diagnostics. */
    expr: string;
    /** Wall-clock ms of the most recent expected fire (in the past). */
    expectedAtMs: number;
    /** What the JobState said — undefined when the job has never fired. */
    lastRunAtMs: number | undefined;
    /** How far behind the last expected fire we are. Negative when on time. */
    delayMs: number;
    /** Whether this run is past the tolerance window and needs a force-fire. */
    stale: boolean;
}

export interface CronSweepResult {
    checked: number;
    stale: CronHealthCheck[];
    forced: string[];
    skipped: Array<{ id: string; reason: string }>;
}

export class CronHealthSweeper {
    constructor(
        private readonly cronTrigger: () => CronTrigger | null,
        private readonly store: StateStore,
        private readonly toleranceMultiplier = DEFAULT_TOLERANCE_MULTIPLIER,
        private readonly minGraceMs = DEFAULT_MIN_GRACE_MS,
    ) {}

    /** Returns null for unpredictable schedules (e.g. fired one-shot `at`). */
    inspectJob(job: JobDefinition, nowMs = Date.now()): CronHealthCheck | null {
        if (!job.enabled) return null;

        const lastRunAt = this.store.getJobStateSync(job.id)?.lastRunAt;

        if (job.schedule.kind === 'at') {
            if (job.schedule.atMs > nowMs) return null;
            // Past-due: stale immediately, no tolerance window.
            return {
                id: job.id,
                name: job.name,
                expr: `at ${new Date(job.schedule.atMs).toISOString()}`,
                expectedAtMs: job.schedule.atMs,
                lastRunAtMs: lastRunAt,
                delayMs: nowMs - job.schedule.atMs,
                stale: lastRunAt === undefined || lastRunAt < job.schedule.atMs,
            };
        }

        if (job.schedule.kind === 'every') {
            const period = job.schedule.everyMs;
            const anchor = job.schedule.anchorMs ?? 0;
            const lastExpected = anchor + Math.floor((nowMs - anchor) / period) * period;
            if (lastExpected > nowMs) return null;
            const tolerance = Math.max(this.minGraceMs, period * this.toleranceMultiplier);
            // Compare against last actual fire — comparing against
            // lastExpected is misleading on frequent jobs.
            const reference = lastRunAt ?? lastExpected;
            const stale = nowMs - reference > tolerance;
            return {
                id: job.id,
                name: job.name,
                expr: `every ${Math.round(period / 1000)}s`,
                expectedAtMs: lastExpected,
                lastRunAtMs: lastRunAt,
                delayMs: nowMs - lastExpected,
                stale,
            };
        }

        // previousRuns(n, date) returns the most recent N expected fires;
        // previousRun() would always be null on a fresh Cron instance.
        const sched = job.schedule;
        try {
            const cron = new Cron(sched.expr, { timezone: sched.tz ?? 'UTC' });
            const prevRuns = cron.previousRuns(1, new Date(nowMs));
            if (!prevRuns || prevRuns.length === 0) return null;
            const expectedAtMs = prevRuns[0]!.getTime();

            const next = cron.nextRun(new Date(expectedAtMs + 1));
            const period = next ? next.getTime() - expectedAtMs : 24 * 60 * 60 * 1000;
            const tolerance = Math.max(this.minGraceMs, period * this.toleranceMultiplier);
            const reference = lastRunAt ?? expectedAtMs;
            const stale = nowMs - reference > tolerance;
            return {
                id: job.id,
                name: job.name,
                expr: sched.expr,
                expectedAtMs,
                lastRunAtMs: lastRunAt,
                delayMs: nowMs - expectedAtMs,
                stale,
            };
        } catch (err) {
            log.warn(
                { jobId: job.id, expr: sched.expr, err },
                'cron expression parse failed during sweep',
            );
            return null;
        }
    }

    async sweep(nowMs = Date.now()): Promise<CronSweepResult> {
        const trigger = this.cronTrigger();
        const out: CronSweepResult = { checked: 0, stale: [], forced: [], skipped: [] };
        if (!trigger) {
            return out;
        }
        const jobs = trigger.listJobs();
        for (const job of jobs) {
            out.checked++;
            const check = this.inspectJob(job, nowMs);
            if (!check) continue;
            if (!check.stale) continue;
            out.stale.push(check);
            try {
                const fired = await trigger.triggerNow(job.id);
                if (fired) {
                    out.forced.push(job.id);
                    log.warn(
                        {
                            jobId: job.id,
                            expr: check.expr,
                            delayMinutes: Math.round(check.delayMs / 60_000),
                        },
                        'force-fired stale cron job (self-healing)',
                    );
                } else {
                    out.skipped.push({ id: job.id, reason: 'triggerNow returned false' });
                }
            } catch (err) {
                out.skipped.push({
                    id: job.id,
                    reason: err instanceof Error ? err.message : String(err),
                });
                log.error({ jobId: job.id, err }, 'force-fire failed during sweep');
            }
        }
        return out;
    }
}
