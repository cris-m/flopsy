import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryMem0Plugin, type Mem0Fetch } from '../mem0-plugin';
import type { Interceptor, InterceptorContext } from 'flopsygraph';

function ctx(): InterceptorContext {
    return { runId: 'r', threadId: 't', configurable: {}, store: new Map() };
}

interface FetchCall {
    url: string;
    method: string;
    body: unknown;
}

function makeFetcher(handler: (call: FetchCall) => { ok: boolean; status: number; body: unknown }): {
    fetcher: Mem0Fetch;
    calls: FetchCall[];
} {
    const calls: FetchCall[] = [];
    const fetcher: Mem0Fetch = async (url, init) => {
        const body = init.body ? JSON.parse(init.body as string) : undefined;
        const call: FetchCall = { url, method: (init.method ?? 'GET').toString(), body };
        calls.push(call);
        const result = handler(call);
        return {
            ok: result.ok,
            status: result.status,
            text: async () => typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
            json: async () => result.body,
        };
    };
    return { fetcher, calls };
}

describe('MemoryMem0Plugin', () => {
    let plugin: Interceptor;
    let calls: FetchCall[];

    beforeEach(() => {
        const fixture = makeFetcher((call) => {
            if (call.url.endsWith('/v1/memories') && call.method === 'POST') {
                return { ok: true, status: 200, body: { results: [{ id: 'mem-123' }] } };
            }
            if (call.url.endsWith('/v1/memories/search')) {
                return {
                    ok: true,
                    status: 200,
                    body: {
                        results: [
                            { id: 'mem-1', memory: 'User is in Tokyo', score: 0.92, created_at: '2026-05-25T00:00:00Z' },
                            { id: 'mem-2', memory: 'User uses Postgres', score: 0.71 },
                        ],
                    },
                };
            }
            return { ok: false, status: 404, body: 'unknown route' };
        });
        calls = fixture.calls;
        plugin = createMemoryMem0Plugin({
            baseUrl: 'http://localhost:8765',
            userId: 'alice',
            requestTimeoutMs: 5000,
            fetcher: fixture.fetcher,
        });
    });

    it('exposes mem0_search and mem0_add tools', () => {
        expect(plugin.tools).toBeDefined();
        expect(plugin.tools!.length).toBe(2);
        const names = plugin.tools!.map((t) => t.name).sort();
        expect(names).toEqual(['mem0_add', 'mem0_search']);
    });

    it('tool descriptions explain when/why/how + reference fallback options', () => {
        const search = plugin.tools!.find((t) => t.name === 'mem0_search')!;
        const add = plugin.tools!.find((t) => t.name === 'mem0_add')!;
        expect(search.description!).toMatch(/WHEN TO USE/);
        expect(search.description!).toMatch(/WHEN NOT TO USE/);
        expect(search.description!).toMatch(/vector_search/);
        expect(add.description!).toMatch(/smart_remember/);
    });

    it('mem0_search calls POST /v1/memories/search with correct payload', async () => {
        const tool = plugin.tools!.find((t) => t.name === 'mem0_search')!;
        const out = JSON.parse((await tool.execute(
            { query: 'where does the user live?', topK: 3 } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.matches.length).toBe(2);
        expect(out.matches[0]!.memory).toBe('User is in Tokyo');
        expect(out.user_id).toBe('alice');

        expect(calls.length).toBe(1);
        expect(calls[0]!.url).toContain('/v1/memories/search');
        expect(calls[0]!.method).toBe('POST');
        expect((calls[0]!.body as { query: string }).query).toBe('where does the user live?');
        expect((calls[0]!.body as { user_id: string }).user_id).toBe('alice');
        expect((calls[0]!.body as { limit: number }).limit).toBe(3);
    });

    it('mem0_add calls POST /v1/memories with messages payload', async () => {
        const tool = plugin.tools!.find((t) => t.name === 'mem0_add')!;
        const out = JSON.parse((await tool.execute(
            { content: 'User just moved to Tokyo' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.added).toBe(true);
        expect(out.id).toBe('mem-123');

        expect(calls.length).toBe(1);
        const body = calls[0]!.body as { messages: Array<{ role: string; content: string }>; user_id: string };
        expect(body.user_id).toBe('alice');
        expect(body.messages[0]!.content).toBe('User just moved to Tokyo');
    });

    it('onMemoryWrite mirrors file writes to Mem0', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Location: Tokyo, Japan', undefined, ctx());
        expect(calls.length).toBe(1);
        expect(calls[0]!.url).toContain('/v1/memories');
        const body = calls[0]!.body as { messages: Array<{ content: string }>; metadata: Record<string, unknown> };
        expect(body.messages[0]!.content).toBe('Location: Tokyo, Japan');
        expect(body.metadata.source).toBe('file-mirror');
        expect(body.metadata.target).toBe('user');
    });

    it('onMemoryWrite does NOT mirror remove actions', async () => {
        await plugin.onMemoryWrite!('remove', 'user', 'Location: Berlin', undefined, ctx());
        expect(calls.length).toBe(0);
    });

    it('returns structured error when Mem0 service is unreachable', async () => {
        const errPlugin = createMemoryMem0Plugin({
            baseUrl: 'http://localhost:8765',
            userId: 'alice',
            fetcher: async () => { throw new Error('ECONNREFUSED'); },
        });
        const tool = errPlugin.tools!.find((t) => t.name === 'mem0_search')!;
        const out = JSON.parse((await tool.execute(
            { query: 'anything' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.error).toMatch(/mem0_search failed/);
        expect(out.hint).toMatch(/vector_search/);
    });
});
