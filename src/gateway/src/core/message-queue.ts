const DEFAULT_COALESCE_DELAY_MS = 300;
const MAX_QUEUED_MESSAGES = 500;

export interface QueuedMessage {
    readonly text: string;
    readonly enqueuedAt: number;
}

export class MessageQueue {
    private buffer: QueuedMessage[] = [];
    private waiter: ((batch: QueuedMessage[]) => void) | null = null;
    private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly coalesceDelayMs: number;

    constructor(coalesceDelayMs: number = DEFAULT_COALESCE_DELAY_MS) {
        this.coalesceDelayMs = coalesceDelayMs;
    }

    get size(): number {
        return this.buffer.length;
    }

    enqueue(text: string): void {
        if (this.buffer.length >= MAX_QUEUED_MESSAGES) {
            this.buffer.shift();
        }

        this.buffer.push({ text, enqueuedAt: Date.now() });

        if (this.waiter) {
            if (this.coalesceTimer) {
                clearTimeout(this.coalesceTimer);
            }

            this.coalesceTimer = setTimeout(() => {
                this.coalesceTimer = null;
                this.flush();
            }, this.coalesceDelayMs);
        }
    }

    dequeue(): Promise<QueuedMessage[]> {
        if (this.buffer.length > 0) {
            return Promise.resolve(this.drain());
        }

        if (this.waiter) {
            const prev = this.waiter;
            this.waiter = null;
            prev([]);
        }

        return new Promise<QueuedMessage[]>((resolve) => {
            this.waiter = resolve;
        });
    }

    clear(): void {
        this.buffer.length = 0;
        if (this.coalesceTimer) {
            clearTimeout(this.coalesceTimer);
            this.coalesceTimer = null;
        }
        if (this.waiter) {
            const resolve = this.waiter;
            this.waiter = null;
            resolve([]);
        }
    }

    private flush(): void {
        if (!this.waiter) return;
        const resolve = this.waiter;
        this.waiter = null;
        resolve(this.drain());
    }

    private drain(): QueuedMessage[] {
        const batch = this.buffer;
        this.buffer = [];
        return batch;
    }
}

export function coalesce(batch: readonly QueuedMessage[]): string {
    if (batch.length === 0) return '';
    if (batch.length === 1) return batch[0].text;
    return batch.map((msg, i) => `[${i + 1}] ${msg.text}`).join('\n');
}
