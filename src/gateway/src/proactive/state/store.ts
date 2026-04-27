import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '@flopsy/shared';
import type { ProactiveState, JobState, UserPresence } from '../types';

const log = createLogger('proactive-state');

const STATE_VERSION = 1;
const MAX_RECENT_DELIVERIES = 50;
const MAX_RECENT_TOPICS = 100;
const MAX_REPORTED_PER_TYPE = 500;

export function getDefaultPresence(): UserPresence {
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
        // Clear any `isExecuting` flags left set by a crash/SIGKILL — otherwise
        // a single bad shutdown permanently suppresses the job on every fire.
        // Process-local mutual exclusion (not persisted) is the intended design.
        let cleared = 0;
        for (const js of Object.values(this.state.jobs)) {
            if (js.isExecuting) {
                js.isExecuting = false;
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
        try {
            if (existsSync(this.filePath)) {
                const raw = readFileSync(this.filePath, 'utf-8');
                const parsed = JSON.parse(raw) as ProactiveState;
                if (parsed.version === STATE_VERSION) return parsed;
                log.warn(
                    { version: parsed.version, expected: STATE_VERSION },
                    'State version mismatch — resetting to defaults',
                );
            }
        } catch (err) {
            log.warn({ err }, 'Failed to load proactive state, using defaults');
        }
        return createDefaultState();
    }

    private flush(): void {
        if (!this.dirty) return;
        try {
            const dir = dirname(this.filePath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
            const tmp = `${this.filePath}.tmp`;
            writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
            renameSync(tmp, this.filePath);
            this.dirty = false;
        } catch (err) {
            log.error({ err }, 'Failed to persist proactive state');
        }
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

    /**
     * Synchronous read for callers on the hot status path — data is all
     * in-memory (loaded into `this.state` on construction). Returns null
     * when the job has no recorded state yet (never fired).
     */
    getJobStateSync(jobId: string): JobState | null {
        const js = this.state.jobs[jobId];
        return js ? { ...js } : null;
    }

    async setJobState(jobId: string, state: JobState): Promise<void> {
        this.state.jobs[jobId] = state;
        this.dirty = true;
    }

    /**
     * Drop the cached stats for a deleted schedule. Without this, every
     * removed heartbeat/cron leaves an orphan record in `jobs[]` that
     * accumulates forever and shows up in `flopsy status` as a ghost
     * schedule.
     */
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

    // ── Config seed marker (one-time import from flopsy.json5) ────────────

    getConfigSeededAt(): number | null {
        return this.state.configSeededAt ?? null;
    }

    markConfigSeeded(): void {
        this.state.configSeededAt = Date.now();
        this.dirty = true;
    }
}
