import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryVectorPlugin } from '../vector-plugin';
import type { Embedder, Interceptor, InterceptorContext } from 'flopsygraph';

function ctx(): InterceptorContext {
    return { runId: 'r', threadId: 't', configurable: {}, store: new Map() };
}

class StubEmbedder implements Embedder {
    readonly dimensions = 8;

    async embed(text: string): Promise<number[]> {
        const v = new Array(8).fill(0);
        const t = text.toLowerCase();
        if (t.includes('tokyo') || t.includes('japan') || t.includes('jst')) v[0] = 1;
        if (t.includes('postgres') || t.includes('database') || t.includes('bytepesa')) v[1] = 1;
        if (t.includes('comedy') || t.includes('chappelle') || t.includes('comedian')) v[2] = 1;
        if (t.includes('hardware') || t.includes('ai') || t.includes('cybersecurity')) v[3] = 1;
        const sum = v.reduce((a, b) => a + b, 0) || 1;
        return v.map((x) => x / Math.sqrt(sum));
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        return Promise.all(texts.map((t) => this.embed(t)));
    }
}

describe('MemoryVectorPlugin', () => {
    let dir: string;
    let plugin: Interceptor;
    let embedder: Embedder;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'flopsy-vector-test-'));
        embedder = new StubEmbedder();
        plugin = createMemoryVectorPlugin({
            dbPath: join(dir, 'mirror.db'),
            embedder,
            defaultTopK: 5,
            minSimilarity: 0.1,
        });
    });

    afterEach(() => {
        try { plugin.teardown?.({} as never); } catch { /* */ }
        rmSync(dir, { recursive: true, force: true });
    });

    it('exposes the vector_search tool', () => {
        expect(plugin.tools).toBeDefined();
        expect(plugin.tools!.length).toBe(1);
        expect(plugin.tools![0]!.name).toBe('vector_search');
    });

    it('tool description is substantial (includes WHEN/EXAMPLES sections)', () => {
        const desc = plugin.tools![0]!.description!;
        expect(desc.length).toBeGreaterThan(500);
        expect(desc).toMatch(/WHEN TO USE/);
        expect(desc).toMatch(/WHEN NOT TO USE/);
        expect(desc).toMatch(/EXAMPLES/);
        expect(desc).toMatch(/RETURNS/);
    });

    it('mirrors writes via onMemoryWrite into the SQLite index', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Location: Tokyo, Japan', undefined, ctx());
        await plugin.onMemoryWrite!('add', 'memory', 'Bytepesa stack: Postgres 16, Prisma ORM', undefined, ctx());

        const tool = plugin.tools![0]!;
        const out = JSON.parse(
            (await tool.execute({ query: 'user lives in Tokyo Japan', namespace: 'all' } as never, {
                signal: new AbortController().signal,
            })) as string,
        );
        expect(out.matches.length).toBeGreaterThan(0);
        expect(out.matches[0]!.content).toContain('Tokyo');
    });

    it('returns helpful empty result when nothing matches threshold', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Location: Tokyo', undefined, ctx());

        const tool = plugin.tools![0]!;
        const out = JSON.parse(
            (await tool.execute({ query: 'something completely unrelated', minSimilarity: 0.95 } as never, {
                signal: new AbortController().signal,
            })) as string,
        );
        expect(out.matches).toEqual([]);
        expect(out.note).toContain('No durable memory');
    });

    it('respects namespace filter', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Comedy: Dave Chappelle', undefined, ctx());
        await plugin.onMemoryWrite!('add', 'memory', 'Project: stand-up comedy show', undefined, ctx());

        const tool = plugin.tools![0]!;
        const userOnly = JSON.parse(
            (await tool.execute({ query: 'comedy', namespace: 'user' } as never, {
                signal: new AbortController().signal,
            })) as string,
        );
        expect(userOnly.matches.every((m: { namespace: string }) => m.namespace === 'user')).toBe(true);
    });

    it('removes entries when onMemoryWrite fires remove action', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Location: Berlin', undefined, ctx());
        await plugin.onMemoryWrite!('remove', 'user', 'Location: Berlin', undefined, ctx());

        const tool = plugin.tools![0]!;
        const out = JSON.parse(
            (await tool.execute({ query: 'Berlin', namespace: 'user', minSimilarity: 0.5 } as never, {
                signal: new AbortController().signal,
            })) as string,
        );
        expect(out.matches.length).toBe(0);
    });

    it('returns matches sorted by similarity descending', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Location: Tokyo Japan', undefined, ctx());
        await plugin.onMemoryWrite!('add', 'memory', 'Bytepesa Postgres database', undefined, ctx());
        await plugin.onMemoryWrite!('add', 'memory', 'AI hardware research', undefined, ctx());

        const tool = plugin.tools![0]!;
        const out = JSON.parse(
            (await tool.execute({ query: 'Tokyo Japan location' } as never, {
                signal: new AbortController().signal,
            })) as string,
        );
        expect(out.matches.length).toBeGreaterThan(0);
        for (let i = 1; i < out.matches.length; i++) {
            expect(out.matches[i - 1]!.similarity).toBeGreaterThanOrEqual(out.matches[i]!.similarity);
        }
        expect(out.matches[0]!.content).toContain('Tokyo');
    });
});
