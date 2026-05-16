import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '@flopsy/shared';
import type { RetryTask } from '../types';
import { RETRY_BACKOFF_MS, RETRY_MAX_ATTEMPTS } from '../types';

const log = createLogger('retry-queue');

/** Hard cap on queue size. Past this, new `add()` calls drop the oldest
 *  task to keep insertion O(1) at the size bound. With three retry tiers
 *  (30s, 2m, 10m) and MAX_ATTEMPTS=3, a steady state of 500 in-flight
 *  retries implies a sustained ~50 failures/min — well past anything a
 *  healthy deployment should ever see. */
const MAX_QUEUE_SIZE = 500;

export class RetryQueue {
    private tasks: RetryTask[] = [];
    private readonly filePath: string;
    /** Index of tasks-by-id for O(1) dedup on add. Rebuilt on load. */
    private readonly index = new Map<string, RetryTask>();

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    async load(): Promise<void> {
        try {
            if (existsSync(this.filePath)) {
                const raw = readFileSync(this.filePath, 'utf-8');
                const parsed = JSON.parse(raw) as RetryTask[];
                if (!Array.isArray(parsed)) {
                    log.warn('retry queue file was not an array — discarding');
                    this.tasks = [];
                    return;
                }
                // Drop tasks that have been stuck in retry for > 24h. They
                // either succeeded behind our back or are stale beyond any
                // useful retry horizon (max backoff is 10min × 3 attempts).
                const cutoff = Date.now() - 24 * 60 * 60 * 1000;
                this.tasks = parsed.filter((t) =>
                    typeof t?.id === 'string' && (t.createdAt ?? 0) > cutoff,
                );
                // Rebuild index. If the file had duplicates (legacy state
                // from before this fix), keep the most-recently-added.
                this.index.clear();
                for (const t of this.tasks) this.index.set(t.id, t);
                log.info({ count: this.tasks.length, dropped: parsed.length - this.tasks.length }, 'Loaded retry queue');
            }
        } catch (err) {
            log.warn({ err }, 'Failed to load retry queue — starting empty');
            this.tasks = [];
            this.index.clear();
        }
    }

    private persistSync(): void {
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

    async persist(): Promise<void> {
        this.persistSync();
    }

    async add(
        task: Omit<RetryTask, 'attempts' | 'maxAttempts' | 'nextRetryAt' | 'createdAt'>,
    ): Promise<void> {
        // Dedup by id — if the same id is already queued (e.g. caller
        // retried add without recordAttempt in between), update the
        // existing entry's payload rather than creating a duplicate that
        // would double-execute on the next tick. RetryTask is a tagged
        // union (`message?` xor `job?`); copy whichever the caller set.
        const existing = this.index.get(task.id);
        if (existing) {
            existing.type = task.type;
            if (task.message !== undefined) existing.message = task.message;
            if (task.job !== undefined) existing.job = task.job;
            this.persistSync();
            log.debug({ taskId: task.id, type: task.type }, 'retry queue: existing entry updated');
            return;
        }

        // Capacity check — drop the oldest entry. We can't drop a
        // currently-claimed entry, but the engine's retry loop only
        // peeks/recordAttempts; there's no "claim" state today.
        if (this.tasks.length >= MAX_QUEUE_SIZE) {
            const dropped = this.tasks.shift();
            if (dropped) {
                this.index.delete(dropped.id);
                log.warn(
                    { droppedId: dropped.id, queueSize: this.tasks.length + 1 },
                    'retry queue at capacity — dropped oldest task',
                );
            }
        }

        const entry: RetryTask = {
            ...task,
            createdAt: Date.now(),
            attempts: 0,
            maxAttempts: RETRY_MAX_ATTEMPTS,
            nextRetryAt: Date.now() + RETRY_BACKOFF_MS[0],
        };
        this.tasks.push(entry);
        this.index.set(entry.id, entry);
        this.persistSync();
        log.debug({ taskId: task.id, type: task.type }, 'Added to retry queue');
    }

    async getDueRetries(now = Date.now()): Promise<RetryTask[]> {
        return this.tasks.filter((t) => t.attempts < t.maxAttempts && t.nextRetryAt <= now);
    }

    async recordAttempt(id: string, success: boolean, error?: string): Promise<boolean> {
        const task = this.index.get(id);
        if (!task) return false;

        task.attempts++;
        task.lastError = error;

        if (success || task.attempts >= task.maxAttempts) {
            this.tasks = this.tasks.filter((t) => t.id !== id);
            this.index.delete(id);
        } else {
            const backoffIdx = Math.min(task.attempts, RETRY_BACKOFF_MS.length - 1);
            task.nextRetryAt = Date.now() + RETRY_BACKOFF_MS[backoffIdx];
        }

        this.persistSync();
        return success;
    }

    async remove(id: string): Promise<void> {
        if (!this.index.has(id)) return;
        this.tasks = this.tasks.filter((t) => t.id !== id);
        this.index.delete(id);
        this.persistSync();
    }

    get size(): number {
        return this.tasks.length;
    }
}
