import { describe, it, expect } from 'vitest';
import { MessageQueue, coalesce, type QueuedMessage } from '../src/core/message-queue';

describe('MessageQueue', () => {
    it('should enqueue and dequeue a single message', async () => {
        const queue = new MessageQueue(0);
        queue.enqueue('hello');
        const batch = await queue.dequeue();
        expect(batch).toHaveLength(1);
        expect(batch[0].text).toBe('hello');
    });

    it('should return buffered messages immediately', async () => {
        const queue = new MessageQueue(0);
        queue.enqueue('a');
        queue.enqueue('b');
        const batch = await queue.dequeue();
        expect(batch).toHaveLength(2);
        expect(batch[0].text).toBe('a');
        expect(batch[1].text).toBe('b');
    });

    it('should wait for messages when buffer is empty', async () => {
        const queue = new MessageQueue(0);

        const promise = queue.dequeue();
        setTimeout(() => queue.enqueue('delayed'), 50);

        const batch = await promise;
        expect(batch).toHaveLength(1);
        expect(batch[0].text).toBe('delayed');
    });

    it('should coalesce rapid messages with delay', async () => {
        const queue = new MessageQueue(100);

        const promise = queue.dequeue();

        queue.enqueue('first');
        await sleep(30);
        queue.enqueue('second');

        const batch = await promise;
        expect(batch).toHaveLength(2);
    });

    it('should evict oldest when over capacity', () => {
        const queue = new MessageQueue(0);
        for (let i = 0; i < 501; i++) {
            queue.enqueue(`msg-${i}`);
        }
        expect(queue.size).toBe(500);
    });

    it('should clear pending messages and resolve waiter with empty', async () => {
        const queue = new MessageQueue(0);

        const promise = queue.dequeue();
        queue.clear();

        const batch = await promise;
        expect(batch).toHaveLength(0);
    });

    it('should report size correctly', () => {
        const queue = new MessageQueue(0);
        expect(queue.size).toBe(0);
        queue.enqueue('a');
        queue.enqueue('b');
        expect(queue.size).toBe(2);
    });
});

describe('coalesce', () => {
    it('should return empty turn for empty batch', () => {
        const result = coalesce([]);
        expect(result.text).toBe('');
        expect(result.media).toEqual([]);
    });

    it('should return text directly for single message', () => {
        const batch: QueuedMessage[] = [{ text: 'hello', enqueuedAt: Date.now() }];
        const result = coalesce(batch);
        expect(result.text).toBe('hello');
        expect(result.media).toEqual([]);
    });

    it('should number multiple messages', () => {
        const batch: QueuedMessage[] = [
            { text: 'fix the bug', enqueuedAt: Date.now() },
            { text: 'update readme', enqueuedAt: Date.now() },
            { text: 'bump version', enqueuedAt: Date.now() },
        ];
        const result = coalesce(batch);
        expect(result.text).toBe('[1] fix the bug\n[2] update readme\n[3] bump version');
    });

    it('should aggregate media across messages', () => {
        const photo = { kind: 'photo', url: 'https://x/1.jpg' } as const;
        const batch: QueuedMessage[] = [
            { text: '[Image]', enqueuedAt: Date.now(), media: [photo], synthetic: true },
            { text: 'caption here', enqueuedAt: Date.now() },
        ];
        const result = coalesce(batch);
        // Synthetic [Image] is dropped in favor of the real caption text.
        expect(result.text).toBe('caption here');
        expect(result.media).toHaveLength(1);
    });
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
