import type { ChannelEvent, IEventQueue } from '../types/agent';

const MAX_QUEUED_EVENTS = 1_000;

/** Internal waiter record — timer + settle function kept together so we can always clear both. */
interface Waiter {
    settle: (notified: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class EventQueue implements IEventQueue {
    private readonly queue: ChannelEvent[] = [];
    private readonly waiters: Set<Waiter> = new Set();

    get size(): number {
        return this.queue.length;
    }

    push(event: ChannelEvent): void {
        if (this.queue.length >= MAX_QUEUED_EVENTS) {
            this.queue.shift();
        }
        this.queue.push(event);
        this.notifyAll(true);
    }

    tryDequeue(): ChannelEvent | null {
        return this.queue.shift() ?? null;
    }

    /**
     * Resolves `true` when an event is pushed (or one is already queued),
     * or `false` on timeout. Multiple concurrent waiters are supported —
     * every caller is notified on the next push. This matters because
     * ChannelWorker.loop races this wait against a stop signal and can
     * start overlapping waits during shutdown.
     */
    waitForEvent(timeoutMs: number): Promise<boolean> {
        if (this.queue.length > 0) return Promise.resolve(true);

        return new Promise<boolean>((resolve) => {
            const waiter: Waiter = {
                settle: (notified) => {
                    clearTimeout(waiter.timer);
                    if (this.waiters.delete(waiter)) resolve(notified);
                },
                timer: setTimeout(() => waiter.settle(false), timeoutMs),
            };
            waiter.timer.unref?.();
            this.waiters.add(waiter);
        });
    }

    clear(): void {
        this.queue.length = 0;
        this.notifyAll(true);
    }

    private notifyAll(notified: boolean): void {
        if (this.waiters.size === 0) return;
        // Snapshot first — `settle` mutates `this.waiters`.
        const snapshot = [...this.waiters];
        this.waiters.clear();
        for (const w of snapshot) {
            clearTimeout(w.timer);
            w.settle(notified);
        }
    }
}
