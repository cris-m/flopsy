import type { Logger } from 'pino';

/**
 * Minimal shape the pool needs from each entry. Concrete `ThreadEntry`
 * extends this; the pool stays generic so it can be unit-tested without
 * dragging in TeamMember/Interceptor/etc.
 */
export interface PoolEntry {
    readonly activeTurns: number;
    readonly lastUsedAt: number;
}

export interface ThreadPoolOptions<E extends PoolEntry> {
    readonly maxThreads: number;
    readonly log: Logger;
    /**
     * Fired AFTER an entry is removed from the pool. Handler wires this to
     * fan-out `onSessionEnd` to interceptors. Errors thrown here are
     * swallowed — the pool keeps its delete-then-notify contract intact.
     */
    onEvict?: (entry: E, threadId: string, reason: 'eviction') => void;
}

/**
 * LRU thread cache shared by `TeamHandler`. Owns the map + eviction policy:
 *   - LRU when over `maxThreads`, skipping any entry with `activeTurns > 0`
 *   - Bulk eviction by peer prefix (used by `/new`, branch-switch, etc.)
 *
 * Generic over the entry type so callers don't have to forward the full
 * `ThreadEntry` shape into the pool's tests.
 */
export class ThreadPool<E extends PoolEntry> {
    private readonly map = new Map<string, E>();

    constructor(private readonly opts: ThreadPoolOptions<E>) {}

    get(key: string): E | undefined {
        return this.map.get(key);
    }

    set(key: string, entry: E): void {
        this.map.set(key, entry);
    }

    delete(key: string): boolean {
        return this.map.delete(key);
    }

    has(key: string): boolean {
        return this.map.has(key);
    }

    keys(): IterableIterator<string> {
        return this.map.keys();
    }

    values(): IterableIterator<E> {
        return this.map.values();
    }

    entries(): IterableIterator<[string, E]> {
        return this.map.entries();
    }

    [Symbol.iterator](): IterableIterator<[string, E]> {
        return this.map.entries();
    }

    get size(): number {
        return this.map.size;
    }

    /** Snapshot + clear. Caller flushes/disposes the returned entries. */
    drain(): E[] {
        const out = [...this.map.values()];
        this.map.clear();
        return out;
    }

    /**
     * Evict every entry whose key is `peerKey` or starts with `peerKey#`.
     * Fires `onEvict` per removed entry. Iteration is snapshotted so
     * `onEvict` can mutate the pool without iterator invalidation.
     */
    evictPeerThreads(peerKey: string): void {
        const prefix = `${peerKey}#`;
        for (const k of [...this.map.keys()]) {
            if (k !== peerKey && !k.startsWith(prefix)) continue;
            const entry = this.map.get(k);
            this.map.delete(k);
            if (entry && this.opts.onEvict) {
                try {
                    this.opts.onEvict(entry, k, 'eviction');
                } catch (err) {
                    this.opts.log.debug(
                        { threadId: k, err: err instanceof Error ? err.message : String(err) },
                        'thread-pool onEvict callback threw (swallowed)',
                    );
                }
            }
        }
    }

    /**
     * LRU-evict one entry when the pool is over capacity. Active entries
     * (`activeTurns > 0`) are skipped — a turn-in-flight must not have its
     * thread yanked. If every entry is active, logs a warn and no-ops.
     */
    evictIfAtCapacity(): void {
        if (this.map.size <= this.opts.maxThreads) return;

        let oldestId: string | undefined;
        let oldestTime = Infinity;
        for (const [id, e] of this.map) {
            if (e.activeTurns > 0) continue;
            if (e.lastUsedAt < oldestTime) {
                oldestTime = e.lastUsedAt;
                oldestId = id;
            }
        }

        if (oldestId === undefined) {
            this.opts.log.warn(
                { size: this.map.size, cap: this.opts.maxThreads },
                'thread cache at capacity but every entry is active; skipping eviction',
            );
            return;
        }

        const victim = this.map.get(oldestId);
        this.map.delete(oldestId);
        if (victim && this.opts.onEvict) {
            try {
                this.opts.onEvict(victim, oldestId, 'eviction');
            } catch (err) {
                this.opts.log.debug(
                    { threadId: oldestId, err: err instanceof Error ? err.message : String(err) },
                    'thread-pool onEvict callback threw (swallowed)',
                );
            }
        }
        this.opts.log.debug({ evicted: oldestId, size: this.map.size }, 'thread evicted (LRU)');
    }
}
