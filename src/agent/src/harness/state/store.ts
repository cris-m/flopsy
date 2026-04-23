import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '@flopsy/shared';
import type { ProactiveState, JobState, UserPresence, QueuedItem } from '@shared/types';

const log = createLogger('state-store');

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
      log.warn({ err }, 'Failed to load state, using defaults');
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
      log.error({ err }, 'Failed to persist state');
    }
  }

  stop(): void {
    this.flush();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async mutate<T>(fn: (state: ProactiveState) => T): Promise<T> {
    const result = fn(this.state);
    this.dirty = true;
    return result;
  }

  async getPresence(): Promise<UserPresence> {
    return this.state.presence;
  }

  async getJobState(jobId: string): Promise<JobState> {
    return this.state.jobs[jobId] ?? getDefaultJobState();
  }

  async setJobState(jobId: string, state: JobState): Promise<void> {
    this.state.jobs[jobId] = state;
    this.dirty = true;
  }

  getQueue(): QueuedItem[] {
    return this.state.queue;
  }

  async addDelivery(content: string, source: string): Promise<void> {
    await this.mutate((state) => {
      state.recentDeliveries.push({
        content,
        deliveredAt: Date.now(),
        source,
      });
      if (state.recentDeliveries.length > MAX_RECENT_DELIVERIES) {
        state.recentDeliveries.shift();
      }
    });
  }

  async addTopic(topic: string, source: string, delivered: boolean): Promise<void> {
    await this.mutate((state) => {
      state.recentTopics.push({
        topic,
        coveredAt: Date.now(),
        source,
        delivered,
      });
      if (state.recentTopics.length > MAX_RECENT_TOPICS) {
        state.recentTopics.shift();
      }
    });
  }

  async addReportedItem(type: 'emails' | 'meetings' | 'tasks' | 'news', item: string): Promise<void> {
    await this.mutate((state) => {
      state.reportedItems[type].push(item);
      if (state.reportedItems[type].length > MAX_REPORTED_PER_TYPE) {
        state.reportedItems[type] = state.reportedItems[type].slice(-MAX_REPORTED_PER_TYPE);
      }
    });
  }
}
