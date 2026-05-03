import type { Media } from '@gateway/types';

const DEFAULT_COALESCE_DELAY_MS = 300;
const MAX_QUEUED_MESSAGES = 500;

export interface QueuedMessage {
    readonly text: string;
    readonly enqueuedAt: number;
    readonly media?: ReadonlyArray<Media>;
    readonly synthetic?: boolean;
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

    enqueue(text: string, media?: ReadonlyArray<Media>, synthetic?: boolean): void {
        if (this.buffer.length >= MAX_QUEUED_MESSAGES) {
            this.buffer.shift();
        }

        this.buffer.push({ text, enqueuedAt: Date.now(), media, synthetic });

        if (this.waiter) {
            if (this.coalesceTimer) {
                clearTimeout(this.coalesceTimer);
            }

            this.coalesceTimer = setTimeout(() => {
                this.coalesceTimer = null;
                this.flush();
            }, this.coalesceDelayMs);
            this.coalesceTimer.unref();
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

export interface CoalescedTurn {
    readonly text: string;
    readonly media: ReadonlyArray<Media>;
}

export function coalesce(batch: readonly QueuedMessage[]): CoalescedTurn {
    if (batch.length === 0) return { text: '', media: [] };

    const allMedia: Media[] = batch.flatMap((m) => (m.media ? [...m.media] : []));

    // Prefer real user text over channel-generated synthetic placeholders
    // (e.g. body="[Image]" when a photo arrives without a caption).
    const realItems = batch.filter((m) => !m.synthetic);

    let text: string;
    if (realItems.length === 1) {
        text = realItems[0].text;
    } else if (realItems.length > 1) {
        text = realItems.map((m, i) => `[${i + 1}] ${m.text}`).join('\n');
    } else {
        text = batch[0].text;
    }

    return { text, media: allMedia };
}
