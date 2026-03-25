export interface ChannelEvent {
    readonly type: 'task_complete' | 'task_error';
    readonly taskId: string;
    readonly result?: string;
    readonly error?: string;
    readonly completedAt: number;
}

const MAX_QUEUED_EVENTS = 1_000;

export class EventQueue {
    private readonly queue: ChannelEvent[] = [];
    private waiter: (() => void) | null = null;

    get size(): number {
        return this.queue.length;
    }

    push(event: ChannelEvent): void {
        if (this.queue.length >= MAX_QUEUED_EVENTS) {
            this.queue.shift();
        }
        this.queue.push(event);
        this.notifyWaiter();
    }

    tryDequeue(): ChannelEvent | null {
        return this.queue.shift() ?? null;
    }

    waitForEvent(timeoutMs: number): Promise<boolean> {
        if (this.queue.length > 0) return Promise.resolve(true);

        return new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                this.waiter = null;
                resolve(false);
            }, timeoutMs);

            this.waiter = () => {
                clearTimeout(timer);
                resolve(true);
            };
        });
    }

    clear(): void {
        this.queue.length = 0;
        this.notifyWaiter();
    }

    private notifyWaiter(): void {
        if (!this.waiter) return;
        const resolve = this.waiter;
        this.waiter = null;
        resolve();
    }
}
