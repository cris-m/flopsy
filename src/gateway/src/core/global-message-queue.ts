/**
 * Global priority message queue — cross-agent observability for the TUI.
 *
 * The per-peer MessageQueue handles coalescing + drainPending for mid-turn
 * messages. This module adds a global singleton with 3-tier priority so the
 * TUI can show "3 messages queued for gandalf" without polling channel-workers.
 *
 * Priority order: now > next > later (FIFO within each tier).
 * - 'now'  — interrupt-class (user sends /cancel, timeout etc.)
 * - 'next' — user input arrived during an active turn
 * - 'later' — system/task notifications that can wait
 */

import { randomUUID } from 'node:crypto';

export type QueuePriority = 'now' | 'next' | 'later';

export interface GlobalQueueEntry {
    readonly id: string;
    readonly threadId: string;
    readonly text: string;
    readonly enqueuedAt: number;
    readonly priority: QueuePriority;
}

const PRIORITY_ORDER: Record<QueuePriority, number> = { now: 0, next: 1, later: 2 };

class GlobalMessageQueue {
    private entries: GlobalQueueEntry[] = [];
    private readonly listeners = new Set<() => void>();

    enqueue(entry: Omit<GlobalQueueEntry, 'id' | 'enqueuedAt'>): string {
        const id = randomUUID();
        const item: GlobalQueueEntry = { ...entry, id, enqueuedAt: Date.now() };
        // Insertion sort: linear scan to find the right position, splice
        // it in. The previous `push + Array.sort` was O(N log N) on every
        // enqueue — fine at small N, but message bursts (50 inbound in
        // one tick across 100 workers) ran 50 full sorts back-to-back.
        //
        // Entries are already mostly sorted (FIFO within priority), so
        // a linear scan from the END almost always finds the spot in
        // O(1) — the new entry's (priority, enqueuedAt) is the largest
        // tuple seen so far. Worst case (an interrupt-priority entry
        // arriving when the queue is full of low-priority ones) is
        // O(N), but that's still strictly better than O(N log N).
        const newPri = PRIORITY_ORDER[item.priority];
        let i = this.entries.length;
        while (i > 0) {
            const prev = this.entries[i - 1]!;
            const prevPri = PRIORITY_ORDER[prev.priority];
            if (prevPri < newPri) break;
            if (prevPri === newPri && prev.enqueuedAt <= item.enqueuedAt) break;
            i--;
        }
        this.entries.splice(i, 0, item);
        this.notify();
        return id;
    }

    /** Remove and return the highest-priority entry matching the filter. */
    dequeue(filter?: (e: GlobalQueueEntry) => boolean): GlobalQueueEntry | undefined {
        const idx = filter
            ? this.entries.findIndex(filter)
            : 0;
        if (idx === -1) return undefined;
        const [item] = this.entries.splice(idx, 1);
        this.notify();
        return item;
    }

    /** Non-destructive view. */
    peek(filter?: (e: GlobalQueueEntry) => boolean): readonly GlobalQueueEntry[] {
        return filter ? this.entries.filter(filter) : [...this.entries];
    }

    remove(id: string): boolean {
        const before = this.entries.length;
        this.entries = this.entries.filter((e) => e.id !== id);
        if (this.entries.length !== before) {
            this.notify();
            return true;
        }
        return false;
    }

    /** React-style subscription for TUI (useSyncExternalStore-compatible). */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Stable snapshot reference changes only when entries change. */
    getSnapshot(): readonly GlobalQueueEntry[] {
        return this.entries;
    }

    get size(): number {
        return this.entries.length;
    }

    private notify(): void {
        for (const l of this.listeners) l();
    }
}

export const globalMessageQueue = new GlobalMessageQueue();
