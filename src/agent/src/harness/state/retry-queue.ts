import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '@flopsy/shared';
import type { RetryTask } from '@shared/types';
import { RETRY_BACKOFF_MS, RETRY_MAX_ATTEMPTS } from '@shared/types';

const log = createLogger('retry-queue');

export class RetryQueue {
  private tasks: RetryTask[] = [];
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        this.tasks = JSON.parse(raw) as RetryTask[];
        log.info({ count: this.tasks.length }, 'Loaded retry queue');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load retry queue');
      this.tasks = [];
    }
  }

  async persist(): Promise<void> {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.tasks, null, 2), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      log.error({ err }, 'Failed to persist retry queue');
    }
  }

  async add(
    task: Omit<RetryTask, 'attempts' | 'maxAttempts' | 'nextRetryAt' | 'createdAt'>,
  ): Promise<void> {
    const entry: RetryTask = {
      ...task,
      createdAt: Date.now(),
      attempts: 0,
      maxAttempts: RETRY_MAX_ATTEMPTS,
      nextRetryAt: Date.now() + RETRY_BACKOFF_MS[0],
    };
    this.tasks.push(entry);
    await this.persist();
    log.debug({ taskId: task.id, type: task.type }, 'Added to retry queue');
  }

  async getDueRetries(now = Date.now()): Promise<RetryTask[]> {
    return this.tasks.filter((t) => t.attempts < t.maxAttempts && t.nextRetryAt <= now);
  }

  async recordAttempt(id: string, success: boolean, error?: string): Promise<boolean> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return false;

    task.attempts++;
    task.lastError = error;

    if (success || task.attempts >= task.maxAttempts) {
      this.tasks = this.tasks.filter((t) => t.id !== id);
    } else {
      const backoffIdx = Math.min(task.attempts, RETRY_BACKOFF_MS.length - 1);
      task.nextRetryAt = Date.now() + RETRY_BACKOFF_MS[backoffIdx];
    }

    await this.persist();
    return success;
  }

  async remove(id: string): Promise<void> {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    await this.persist();
  }

  get size(): number {
    return this.tasks.length;
  }
}
