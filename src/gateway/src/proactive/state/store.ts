import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    writeSync,
} from 'fs';
import { dirname } from 'path';
import { createLogger } from '@flopsy/shared';
import type { ProactiveState, JobState, UserPresence } from '../types';

const log = createLogger('proactive-state');

const STATE_VERSION = 1;
const MAX_RECENT_DELIVERIES = 50;
const MAX_RECENT_SUPPRESSIONS = 50;
const MAX_RECENT_TOPICS = 100;
const MAX_REPORTED_PER_TYPE = 500;
/** Cap on remembered one-shot completion ids. */
const MAX_COMPLETED_ONESHOTS = 1000;
/** Drop job states that haven't fired in 180 days. */
const STALE_JOB_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** 5 min window — past this, isExecuting=true is treated as crashed-run leftover. */
export const STALE_LOCK_MS = 300_000;

function getDefaultPresence(): UserPresence {
    return {
        lastMessageAt: 0,
        activityWindow: 'away',
    };
}

export function getDefaultJobState(): JobState {
    return {
        runCount: 0,
        deliveredCount: 0,
        suppressedCount: 0,
        queuedCount: 0,
        consecutiveErrors: 0,
    };
}

function createDefaultState(): ProactiveState {
    return {
        version: STATE_VERSION,
        presence: getDefaultPresence(),
        jobs: {},
        reportedItems: {
            emails: [],
            meetings: [],
            tasks: [],
            news: [],
        },
        recentDeliveries: [],
        recentSuppressions: [],
        recentTopics: [],
    };
}

export class StateStore {
    private state: ProactiveState;
    private readonly filePath: string;
    private dirty = false;
    private flushTimer: ReturnType<typeof setInterval> | null = null;

    constructor(filePath: string) {
        this.filePath = filePath;
        this.state = this.load();
        // Clear isExecuting flags left by SIGKILL — unconditional on boot.
        let cleared = 0;
        for (const js of Object.values(this.state.jobs)) {
            if (js.isExecuting) {
                js.isExecuting = false;
                js.executingSinceMs = undefined;
                cleared++;
            }
        }
        if (cleared > 0) {
            this.dirty = true;
            log.warn({ cleared }, 'cleared stale isExecuting flags on boot');
        }
        this.flushTimer = setInterval(() => this.flush(), 10_000);
        this.flushTimer.unref();
        log.info(
            {
                filePath,
                jobs: Object.keys(this.state.jobs).length,
            },
            'state store initialized',
        );
    }

    private load(): ProactiveState {
        if (!existsSync(this.filePath)) return createDefaultState();

        let raw: string;
        try {
            raw = readFileSync(this.filePath, 'utf-8');
        } catch (err) {
            log.warn({ err }, 'Failed to read proactive state file; using defaults');
            return createDefaultState();
        }

        let parsed: ProactiveState;
        try {
            parsed = JSON.parse(raw) as ProactiveState;
        } catch (err) {
            // Quarantine BEFORE defaults — first flush() would overwrite recoverable state.
            this.quarantine('parse-failed', err);
            return createDefaultState();
        }

        if (parsed.version !== STATE_VERSION) {
            this.quarantine(`version-mismatch-${parsed.version}-vs-${STATE_VERSION}`);
            return createDefaultState();
        }

        try {
            this.cleanupStaleData(parsed);
            return parsed;
        } catch (err) {
            // Schema drift — quarantine for human recovery.
            this.quarantine('cleanup-failed', err);
            return createDefaultState();
        }
    }

    /** Drop stale job states and aged-out reported items on load. */
    private cleanupStaleData(state: ProactiveState): void {
        const now = Date.now();
        let droppedJobs = 0;
        for (const [id, js] of Object.entries(state.jobs)) {
            const lastActive = js.lastRunAt ?? js.lastStatusAt ?? 0;
            if (lastActive > 0 && now - lastActive > STALE_JOB_AGE_MS) {
                delete state.jobs[id];
                droppedJobs++;
            }
        }
        let droppedReported = 0;
        for (const type of ['emails', 'meetings', 'tasks', 'news'] as const) {
            const items = state.reportedItems[type];
            // No per-item timestamps — just trim to cap.
            if (items.length > MAX_REPORTED_PER_TYPE) {
                items.splice(0, items.length - MAX_REPORTED_PER_TYPE);
                droppedReported += items.length;
            }
        }
        if (droppedJobs > 0 || droppedReported > 0) {
            log.info(
                { droppedJobs, droppedReported },
                'cleaned stale proactive state entries on boot',
            );
        }
    }

    private flush(): void {
        if (!this.dirty) return;
        try {
            const dir = dirname(this.filePath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
            const tmp = `${this.filePath}.tmp`;
            // open+write+fsync+close+rename — fsync guards against 0-byte files on crash.
            const fd = openSync(tmp, 'w', 0o600);
            try {
                writeSync(fd, JSON.stringify(this.state, null, 2));
                fsyncSync(fd);
            } finally {
                closeSync(fd);
            }
            renameSync(tmp, this.filePath);
            this.dirty = false;
        } catch (err) {
            log.error({ err }, 'Failed to persist proactive state');
        }
    }

    /**
     * Move the (presumed-corrupt) state file aside before falling back
     * to defaults. Names the quarantine file with a timestamp + reason
     * so an operator can run `ls -la <FLOPSY_HOME>/state/` and immediately
     * see what happened, then `mv` the `.bad-*` back into place if the
     * corruption is recoverable.
     */
    private quarantine(reason: string, err?: unknown): void {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const quarantinePath = `${this.filePath}.bad-${ts}-${reason}`;
        try {
            renameSync(this.filePath, quarantinePath);
            log.error(
                { reason, quarantinePath, err },
                'Quarantined corrupt proactive state; starting fresh from defaults',
            );
        } catch (renameErr) {
            // If even the rename fails (read-only fs, permissions, …)
            // log loudly. Better to spam an error per boot than to
            // silently overwrite.
            log.error(
                { reason, err, renameErr },
                'Failed to quarantine corrupt proactive state — original file will be overwritten on next flush',
            );
        }
    }

    /**
     * Force a synchronous flush — use after critical writes (post-delivery
     * `addDelivery`, lock acquisition) so a crash inside the 10s timer
     * window can't lose state. Cheap (small JSON, atomic rename); call
     * sparingly — once per delivered fire is fine.
     */
    flushNow(): void {
        this.flush();
    }

    stop(): void {
        this.flush();
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        log.debug('state store stopped');
    }

    async mutate<T>(fn: (state: ProactiveState) => T): Promise<T> {
        const result = fn(this.state);
        this.dirty = true;
        return result;
    }

    async getPresence(): Promise<UserPresence> {
        return { ...this.state.presence };
    }

    async getJobState(jobId: string): Promise<JobState> {
        return this.state.jobs[jobId] ? { ...this.state.jobs[jobId] } : getDefaultJobState();
    }

    /** Sync read for the hot status path. Null when never fired. */
    getJobStateSync(jobId: string): JobState | null {
        const js = this.state.jobs[jobId];
        return js ? { ...js } : null;
    }

    async setJobState(jobId: string, state: JobState): Promise<void> {
        this.state.jobs[jobId] = state;
        this.dirty = true;
    }

    deleteJobState(jobId: string): boolean {
        if (!(jobId in this.state.jobs)) return false;
        delete this.state.jobs[jobId];
        this.dirty = true;
        return true;
    }

    async addDelivery(content: string, source: string): Promise<void> {
        this.state.recentDeliveries.unshift({
            content: content.slice(0, 500),
            deliveredAt: Date.now(),
            source,
        });
        if (this.state.recentDeliveries.length > MAX_RECENT_DELIVERIES) {
            this.state.recentDeliveries.length = MAX_RECENT_DELIVERIES;
        }
        this.dirty = true;
    }

    /**
     * Record a candidate message the agent composed but suppressed
     * (`shouldDeliver=false`). Used by anti-rep so the next fire knows
     * "we already considered this and rejected it" — without this, the
     * picker re-proposes the same topic 5 minutes later.
     */
    async addSuppression(
        content: string,
        source: string,
        meta: { reason?: string; mode?: string } = {},
    ): Promise<void> {
        if (!this.state.recentSuppressions) this.state.recentSuppressions = [];
        this.state.recentSuppressions.unshift({
            content: content.slice(0, 500),
            suppressedAt: Date.now(),
            source,
            ...(meta.reason ? { reason: meta.reason.slice(0, 300) } : {}),
            ...(meta.mode ? { mode: meta.mode } : {}),
        });
        if (this.state.recentSuppressions.length > MAX_RECENT_SUPPRESSIONS) {
            this.state.recentSuppressions.length = MAX_RECENT_SUPPRESSIONS;
        }
        this.dirty = true;
    }

    getRecentSuppressions(): Readonly<NonNullable<ProactiveState['recentSuppressions']>> {
        return this.state.recentSuppressions ?? [];
    }

    async addTopic(topic: string, source: string, delivered: boolean): Promise<void> {
        this.state.recentTopics.unshift({
            topic,
            coveredAt: Date.now(),
            source,
            delivered,
        });
        if (this.state.recentTopics.length > MAX_RECENT_TOPICS) {
            this.state.recentTopics.length = MAX_RECENT_TOPICS;
        }
        this.dirty = true;
    }

    async addReportedItem(type: keyof ProactiveState['reportedItems'], id: string): Promise<void> {
        const list = this.state.reportedItems[type];
        if (!list.includes(id)) {
            list.push(id);
            if (list.length > MAX_REPORTED_PER_TYPE) {
                list.splice(0, list.length - MAX_REPORTED_PER_TYPE);
            }
            this.dirty = true;
        }
    }

    async isReported(type: keyof ProactiveState['reportedItems'], id: string): Promise<boolean> {
        return this.state.reportedItems[type].includes(id);
    }

    getRecentDeliveries(): Readonly<ProactiveState['recentDeliveries']> {
        return this.state.recentDeliveries;
    }

    getRecentTopics(): Readonly<ProactiveState['recentTopics']> {
        return this.state.recentTopics;
    }

    isOneshotCompleted(id: string): boolean {
        return this.state.completedOneshots?.includes(id) ?? false;
    }

    markOneshotCompleted(id: string): void {
        if (!this.state.completedOneshots) this.state.completedOneshots = [];
        if (!this.state.completedOneshots.includes(id)) {
            this.state.completedOneshots.push(id);
            // FIFO cap: this list only exists to suppress re-firing of
            // one-shot schedules whose definition was deleted. Once a
            // schedule is gone, its id will never be looked up again,
            // so we don't need history beyond the most recent N. Without
            // this cap, a long-lived deployment with many ad-hoc at-jobs
            // grows the state file unbounded — proactive.json grows
            // until the next flushSync stalls the event loop.
            if (this.state.completedOneshots.length > MAX_COMPLETED_ONESHOTS) {
                this.state.completedOneshots.splice(
                    0,
                    this.state.completedOneshots.length - MAX_COMPLETED_ONESHOTS,
                );
            }
            this.dirty = true;
        }
    }

    clearOneshotCompleted(id: string): boolean {
        const list = this.state.completedOneshots;
        if (!list) return false;
        const idx = list.indexOf(id);
        if (idx < 0) return false;
        list.splice(idx, 1);
        this.dirty = true;
        return true;
    }

    getConfigSeededAt(): number | null {
        return this.state.configSeededAt ?? null;
    }

    markConfigSeeded(): void {
        this.state.configSeededAt = Date.now();
        this.dirty = true;
    }
}
