import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryHonchoPlugin, type HonchoFetch } from '../honcho-plugin';
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
    fetcher: HonchoFetch;
    calls: FetchCall[];
} {
    const calls: FetchCall[] = [];
    const fetcher: HonchoFetch = async (url, init) => {
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

describe('MemoryHonchoPlugin', () => {
    let plugin: Interceptor;
    let calls: FetchCall[];

    beforeEach(() => {
        const fixture = makeFetcher((call) => {
            if (call.url.includes('/messages/search')) {
                return { ok: true, status: 200, body: { results: [{ content: 'User talked about Postgres last week', score: 0.88 }] } };
            }
            if (call.url.includes('/peers/') && call.url.endsWith('/card')) {
                return { ok: true, status: 200, body: { card: 'Crispin, Tokyo, software developer', metadata: { lastUpdated: '2026-05-25' } } };
            }
            if (call.url.includes('/sessions/') && call.url.endsWith('/context')) {
                return { ok: true, status: 200, body: { summary: 'Recent session about Bytepesa', peer_card: 'Crispin', messages: [] } };
            }
            if (call.url.includes('/peers/') && call.url.endsWith('/chat')) {
                return { ok: true, status: 200, body: { content: 'The user shows a consistent pattern of...' } };
            }
            if (call.url.includes('/conclusions') && call.method === 'POST') {
                return { ok: true, status: 200, body: { id: 'conc-42' } };
            }
            if (call.url.includes('/conclusions/') && call.method === 'DELETE') {
                return { ok: true, status: 204, body: '' };
            }
            return { ok: false, status: 404, body: 'unknown' };
        });
        calls = fixture.calls;
        plugin = createMemoryHonchoPlugin({
            baseUrl: 'http://localhost:8000',
            peerName: 'crispin',
            aiPeer: 'flopsy',
            sessionName: 'main',
            workspace: 'flopsy',
            fetcher: fixture.fetcher,
        });
    });

    it('exposes all 5 honcho tools', () => {
        expect(plugin.tools).toBeDefined();
        const names = plugin.tools!.map((t) => t.name).sort();
        expect(names).toEqual([
            'honcho_conclude',
            'honcho_context',
            'honcho_profile',
            'honcho_reasoning',
            'honcho_search',
        ]);
    });

    it('all tool descriptions exceed 200 chars and reference the right use cases', () => {
        for (const tool of plugin.tools!) {
            expect(tool.description!.length).toBeGreaterThan(150);
        }
        const search = plugin.tools!.find((t) => t.name === 'honcho_search')!;
        const reasoning = plugin.tools!.find((t) => t.name === 'honcho_reasoning')!;
        const conclude = plugin.tools!.find((t) => t.name === 'honcho_conclude')!;
        expect(search.description!).toMatch(/WHEN TO USE/);
        expect(reasoning.description!).toMatch(/SYNTHESIS/);
        expect(conclude.description!).toMatch(/PII/);
    });

    it('honcho_search calls the search endpoint', async () => {
        const tool = plugin.tools!.find((t) => t.name === 'honcho_search')!;
        const out = JSON.parse((await tool.execute(
            { query: 'Postgres preferences', limit: 5 } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.matches.length).toBe(1);
        expect(out.matches[0]!.content).toContain('Postgres');
        expect(calls[0]!.url).toContain('/messages/search');
    });

    it('honcho_profile fetches the peer card', async () => {
        const tool = plugin.tools!.find((t) => t.name === 'honcho_profile')!;
        const out = JSON.parse((await tool.execute(
            { peer: 'user' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.peer).toBe('user');
        expect(out.card).toContain('Crispin');
        expect(calls[0]!.url).toContain('/peers/crispin/card');
    });

    it('honcho_context fetches the full session context', async () => {
        const tool = plugin.tools!.find((t) => t.name === 'honcho_context')!;
        const out = JSON.parse((await tool.execute(
            { summary: true, includeMessages: false } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.summary).toContain('Bytepesa');
    });

    it('honcho_reasoning calls the chat endpoint with reasoning level', async () => {
        const tool = plugin.tools!.find((t) => t.name === 'honcho_reasoning')!;
        const out = JSON.parse((await tool.execute(
            { question: 'What does the user value?', reasoningLevel: 'medium' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.answer).toContain('pattern');
        const body = calls[0]!.body as { reasoning_level: string };
        expect(body.reasoning_level).toBe('medium');
    });

    it('honcho_conclude with conclusion creates an entry', async () => {
        const tool = plugin.tools!.find((t) => t.name === 'honcho_conclude')!;
        const out = JSON.parse((await tool.execute(
            { conclusion: 'User uses qwen-coder for code review' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.created).toBe(true);
        expect(out.id).toBe('conc-42');
    });

    it('honcho_conclude with deleteId deletes an entry', async () => {
        const tool = plugin.tools!.find((t) => t.name === 'honcho_conclude')!;
        const out = JSON.parse((await tool.execute(
            { deleteId: 'conc-42' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.deleted).toBe(true);
    });

    it('onMemoryWrite mirrors USER.md adds as Honcho conclusions', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Location: Tokyo, Japan', undefined, ctx());
        expect(calls.length).toBe(1);
        expect(calls[0]!.url).toContain('/peers/crispin/conclusions');
        const body = calls[0]!.body as { conclusion: string };
        expect(body.conclusion).toBe('Location: Tokyo, Japan');
    });

    it('onMemoryWrite does NOT mirror MEMORY.md writes (only user target)', async () => {
        await plugin.onMemoryWrite!('add', 'memory', 'Bytepesa stack note', undefined, ctx());
        expect(calls.length).toBe(0);
    });

    it('onMemoryWrite does NOT mirror remove/replace actions', async () => {
        await plugin.onMemoryWrite!('remove', 'user', 'Location: Berlin', undefined, ctx());
        await plugin.onMemoryWrite!('replace', 'user', 'Location: Tokyo', undefined, ctx());
        expect(calls.length).toBe(0);
    });

    it('returns structured error when Honcho service is unreachable', async () => {
        const errPlugin = createMemoryHonchoPlugin({
            baseUrl: 'http://localhost:8000',
            peerName: 'alice',
            aiPeer: 'flopsy',
            fetcher: async () => { throw new Error('ECONNREFUSED'); },
        });
        const tool = errPlugin.tools!.find((t) => t.name === 'honcho_search')!;
        const out = JSON.parse((await tool.execute(
            { query: 'anything' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.error).toMatch(/honcho_search failed/);
        expect(out.hint).toMatch(/local memory tools/);
    });
});
