import { describe, it, expect } from 'vitest';
import { createLogger } from '@flopsy/shared';
import { ThreadPool, type PoolEntry } from '../../../src/team/src/handler/thread-pool';

interface TestEntry extends PoolEntry {
    readonly tag: string;
    readonly activeTurns: number;
    readonly lastUsedAt: number;
}

const log = createLogger('test-thread-pool');

function makeEntry(tag: string, lastUsedAt: number, activeTurns = 0): TestEntry {
    return { tag, lastUsedAt, activeTurns };
}

describe('ThreadPool', () => {
    it('get/set/delete/has/size behave like Map', () => {
        const pool = new ThreadPool<TestEntry>({ maxThreads: 10, log });
        pool.set('a', makeEntry('A', 100));
        pool.set('b', makeEntry('B', 200));
        expect(pool.size).toBe(2);
        expect(pool.has('a')).toBe(true);
        expect(pool.get('a')!.tag).toBe('A');
        expect(pool.delete('a')).toBe(true);
        expect(pool.delete('a')).toBe(false);
        expect(pool.size).toBe(1);
    });

    it('iterates entries with for...of via Symbol.iterator', () => {
        const pool = new ThreadPool<TestEntry>({ maxThreads: 10, log });
        pool.set('a', makeEntry('A', 100));
        pool.set('b', makeEntry('B', 200));
        const seen: Array<[string, string]> = [];
        for (const [k, e] of pool) seen.push([k, e.tag]);
        expect(seen).toEqual([['a', 'A'], ['b', 'B']]);
    });

    it('drain returns all entries and clears the pool', () => {
        const pool = new ThreadPool<TestEntry>({ maxThreads: 10, log });
        pool.set('a', makeEntry('A', 100));
        pool.set('b', makeEntry('B', 200));
        const drained = pool.drain();
        expect(drained.map((e) => e.tag).sort()).toEqual(['A', 'B']);
        expect(pool.size).toBe(0);
    });

    it('evictPeerThreads removes peerKey and peerKey# prefix keys, fires onEvict per entry', () => {
        const evicted: string[] = [];
        const pool = new ThreadPool<TestEntry>({
            maxThreads: 10,
            log,
            onEvict: (_entry, key) => evicted.push(key),
        });
        pool.set('peer1', makeEntry('a', 1));
        pool.set('peer1#s1', makeEntry('b', 2));
        pool.set('peer1#s2', makeEntry('c', 3));
        pool.set('peer2', makeEntry('d', 4));
        pool.set('peer2#s1', makeEntry('e', 5));

        pool.evictPeerThreads('peer1');

        expect(pool.has('peer1')).toBe(false);
        expect(pool.has('peer1#s1')).toBe(false);
        expect(pool.has('peer1#s2')).toBe(false);
        expect(pool.has('peer2')).toBe(true);
        expect(pool.has('peer2#s1')).toBe(true);
        expect(evicted.sort()).toEqual(['peer1', 'peer1#s1', 'peer1#s2']);
    });

    it('evictIfAtCapacity removes the LRU non-active entry', () => {
        const evicted: string[] = [];
        const pool = new ThreadPool<TestEntry>({
            maxThreads: 2,
            log,
            onEvict: (_entry, key) => evicted.push(key),
        });
        pool.set('a', makeEntry('A', 100));
        pool.set('b', makeEntry('B', 200));
        pool.set('c', makeEntry('C', 300));

        pool.evictIfAtCapacity();

        expect(evicted).toEqual(['a']);
        expect(pool.size).toBe(2);
        expect(pool.has('a')).toBe(false);
    });

    it('evictIfAtCapacity skips entries with activeTurns > 0', () => {
        const evicted: string[] = [];
        const pool = new ThreadPool<TestEntry>({
            maxThreads: 2,
            log,
            onEvict: (_entry, key) => evicted.push(key),
        });
        pool.set('a', makeEntry('A', 100, 2));   // active, oldest — should be skipped
        pool.set('b', makeEntry('B', 200));      // idle, second-oldest — should be evicted
        pool.set('c', makeEntry('C', 300));      // idle, newest

        pool.evictIfAtCapacity();

        expect(evicted).toEqual(['b']);
    });

    it('evictIfAtCapacity no-ops when every entry is active', () => {
        const evicted: string[] = [];
        const pool = new ThreadPool<TestEntry>({
            maxThreads: 1,
            log,
            onEvict: (_entry, key) => evicted.push(key),
        });
        pool.set('a', makeEntry('A', 100, 1));
        pool.set('b', makeEntry('B', 200, 1));

        pool.evictIfAtCapacity();

        expect(evicted).toEqual([]);
        expect(pool.size).toBe(2);
    });

    it('evictIfAtCapacity is a no-op below capacity', () => {
        const evicted: string[] = [];
        const pool = new ThreadPool<TestEntry>({
            maxThreads: 10,
            log,
            onEvict: (_entry, key) => evicted.push(key),
        });
        pool.set('a', makeEntry('A', 1));
        pool.set('b', makeEntry('B', 2));

        pool.evictIfAtCapacity();

        expect(evicted).toEqual([]);
        expect(pool.size).toBe(2);
    });

    it('onEvict thrown error is swallowed (pool state still consistent)', () => {
        const pool = new ThreadPool<TestEntry>({
            maxThreads: 1,
            log,
            onEvict: () => { throw new Error('callback boom'); },
        });
        pool.set('a', makeEntry('A', 1));
        pool.set('b', makeEntry('B', 2));

        expect(() => pool.evictIfAtCapacity()).not.toThrow();
        expect(pool.size).toBe(1);
        expect(pool.has('a')).toBe(false);
    });
});
