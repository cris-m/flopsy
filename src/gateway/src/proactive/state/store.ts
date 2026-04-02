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
        queue: [],
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
        this.flushTimer = setInterval(() => this.flush(), 10_000);
        this.flushTimer.unref();
        log.info(
            {
                filePath,
                jobs: Object.keys(this.state.jobs).length,
                queueSize: this.state.queue.length,
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
                log.warn({ version: parsed.version }, 'State version mismatch, resetting');
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

    async setJobState(jobId: string, state: JobState): Promise<void> {
        this.state.jobs[jobId] = state;
        this.dirty = true;
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

    getQueue(): Readonly<ProactiveState['queue']> {
        return this.state.queue;
    }

    getRecentDeliveries(): Readonly<ProactiveState['recentDeliveries']> {
        return this.state.recentDeliveries;
    }

    getRecentTopics(): Readonly<ProactiveState['recentTopics']> {
        return this.state.recentTopics;
    }
}
