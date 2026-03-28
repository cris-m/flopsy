import { describe, it, expect } from 'vitest';
import { EventQueue } from '../src/core/event-queue';
import type { ChannelEvent } from '../src/types/agent';

function makeEvent(overrides: Partial<ChannelEvent> = {}): ChannelEvent {
    return {
        type: 'task_complete',
        taskId: 'test-1',
        result: 'done',
        completedAt: Date.now(),
        ...overrides,
    };
}

describe('EventQueue', () => {
    it('should push and dequeue events in FIFO order', () => {
        const queue = new EventQueue();
        const e1 = makeEvent({ taskId: 'a' });
        const e2 = makeEvent({ taskId: 'b' });

        queue.push(e1);
        queue.push(e2);

        expect(queue.size).toBe(2);
        expect(queue.tryDequeue()).toEqual(e1);
        expect(queue.tryDequeue()).toEqual(e2);
        expect(queue.tryDequeue()).toBeNull();
    });

    it('should return null when empty', () => {
        const queue = new EventQueue();
        expect(queue.tryDequeue()).toBeNull();
    });

    it('should evict oldest when over capacity', () => {
        const queue = new EventQueue();
        for (let i = 0; i < 1_001; i++) {
            queue.push(makeEvent({ taskId: `task-${i}` }));
        }
        expect(queue.size).toBe(1_000);
        const first = queue.tryDequeue()!;
        expect(first.taskId).toBe('task-1');
    });

    it('should resolve waitForEvent immediately when events exist', async () => {
        const queue = new EventQueue();
        queue.push(makeEvent());
        const result = await queue.waitForEvent(1_000);
        expect(result).toBe(true);
    });

    it('should resolve waitForEvent when event is pushed', async () => {
        const queue = new EventQueue();

        const promise = queue.waitForEvent(5_000);
        setTimeout(() => queue.push(makeEvent()), 50);

        const result = await promise;
        expect(result).toBe(true);
    });

    it('should timeout waitForEvent when no events arrive', async () => {
        const queue = new EventQueue();
        const result = await queue.waitForEvent(50);
        expect(result).toBe(false);
    });

    it('should clear all events and resolve waiters', async () => {
        const queue = new EventQueue();
        queue.push(makeEvent());
        queue.push(makeEvent());
        queue.clear();
        expect(queue.size).toBe(0);
        expect(queue.tryDequeue()).toBeNull();
    });
});
