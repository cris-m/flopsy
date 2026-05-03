/**
 * RetryQueue — durable queue for failed deliveries with exponential backoff.
 *
 * Wrong here = the bot either spams retries (too aggressive) or silently
 * drops messages (drains too fast / never retries). Both are user-visible.
 *
 * Covers:
 *   - add: stamps createdAt, attempts=0, nextRetryAt at first backoff window
 *   - getDueRetries: filters by nextRetryAt and attempts<maxAttempts
 *   - recordAttempt success → drops the row + returns true
 *   - recordAttempt failure → bumps attempts, advances nextRetryAt by backoff
 *   - recordAttempt at max attempts → drops the row regardless
 *   - load / persist round-trip via disk
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RetryQueue } from '@flopsy/gateway/proactive';

const QUEUE_FILE = 'retry.json';

let tmpDir: string;
let queue: RetryQueue;

beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flopsy-retry-'));
    queue = new RetryQueue(join(tmpDir, QUEUE_FILE));
    await queue.load();
});

afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
});

describe('RetryQueue.add', () => {
    it('stamps fresh task with attempts=0 and nextRetryAt in the future', async () => {
        const before = Date.now();
        await queue.add({
            id: 't1',
            type: 'message',
            message: {
                channel: 'telegram',
                peer: { id: '1', type: 'user' },
                content: 'hi',
            },
        } as Parameters<RetryQueue['add']>[0]);
        expect(queue.size).toBe(1);
        const due = await queue.getDueRetries(before - 1);
        // Not due yet (in the backoff window).
        expect(due).toHaveLength(0);
    });

    it('persists to disk on add', async () => {
        await queue.add({
            id: 'persist-me',
            type: 'message',
            message: {
                channel: 't',
                peer: { id: '1', type: 'user' },
                content: 'x',
            },
        } as Parameters<RetryQueue['add']>[0]);
        const path = join(tmpDir, QUEUE_FILE);
        expect(existsSync(path)).toBe(true);
        const persisted = JSON.parse(readFileSync(path, 'utf-8'));
        expect(persisted).toHaveLength(1);
        expect(persisted[0].id).toBe('persist-me');
    });
});

describe('RetryQueue.getDueRetries', () => {
    it('returns tasks whose nextRetryAt has passed', async () => {
        await queue.add({
            id: 'a', type: 'job',
            job: { id: 'j1', name: 'n', source: 'cron', context: {} },
        } as Parameters<RetryQueue['add']>[0]);
        // Pretend the future has arrived: pass `now` past first backoff window.
        const due = await queue.getDueRetries(Date.now() + 60_000);
        expect(due).toHaveLength(1);
        expect(due[0]!.id).toBe('a');
    });

    it('skips tasks at or above maxAttempts', async () => {
        await queue.add({
            id: 'maxed', type: 'job',
            job: { id: 'j', name: 'n', source: 'cron', context: {} },
        } as Parameters<RetryQueue['add']>[0]);
        // Exhaust by recording max failures (the helper drops on max-out).
        for (let i = 0; i < 3; i++) {
            await queue.recordAttempt('maxed', false, 'err');
        }
        // After hitting max, the task is removed entirely.
        expect(queue.size).toBe(0);
        expect(await queue.getDueRetries(Date.now() + 1_000_000)).toHaveLength(0);
    });
});

describe('RetryQueue.recordAttempt', () => {
    async function addOne(id = 't1') {
        await queue.add({
            id, type: 'message',
            message: {
                channel: 't',
                peer: { id: '1', type: 'user' },
                content: 'x',
            },
        } as Parameters<RetryQueue['add']>[0]);
    }

    it('returns false on unknown id', async () => {
        expect(await queue.recordAttempt('nope', true)).toBe(false);
    });

    it('on success: drops the task and returns true', async () => {
        await addOne();
        expect(await queue.recordAttempt('t1', true)).toBe(true);
        expect(queue.size).toBe(0);
    });

    it('on failure: keeps the task, bumps attempts, schedules next backoff', async () => {
        await addOne();
        const ok = await queue.recordAttempt('t1', false, 'rate limited');
        // recordAttempt returns the success flag — false here because the call failed.
        expect(ok).toBe(false);
        expect(queue.size).toBe(1);
        // Force "now" past the next backoff and confirm it surfaces as due.
        const due = await queue.getDueRetries(Date.now() + 24 * 60 * 60_000);
        expect(due).toHaveLength(1);
        expect(due[0]!.attempts).toBe(1);
        expect(due[0]!.lastError).toBe('rate limited');
    });

    it('on max-attempts failure: drops the task', async () => {
        await addOne();
        // Three attempts at max → dropped.
        for (let i = 0; i < 3; i++) {
            await queue.recordAttempt('t1', false, 'err');
        }
        expect(queue.size).toBe(0);
    });

    it('persists across reloads', async () => {
        await addOne('persist-a');
        await addOne('persist-b');
        await queue.recordAttempt('persist-a', false, 'transient');

        // Construct a fresh queue from the same file.
        queue = new RetryQueue(join(tmpDir, QUEUE_FILE));
        await queue.load();
        expect(queue.size).toBe(2);
        const aRow = (await queue.getDueRetries(Date.now() + 24 * 60 * 60_000))
            .find((t) => t.id === 'persist-a');
        expect(aRow!.attempts).toBe(1);
    });
});

describe('RetryQueue.remove', () => {
    it('removes a task by id', async () => {
        await queue.add({
            id: 'rm',
            type: 'message',
            message: { channel: 't', peer: { id: '1', type: 'user' }, content: 'x' },
        } as Parameters<RetryQueue['add']>[0]);
        await queue.remove('rm');
        expect(queue.size).toBe(0);
    });

    it('is a no-op for unknown id (does not throw)', async () => {
        await expect(queue.remove('unknown')).resolves.toBeUndefined();
    });
});
