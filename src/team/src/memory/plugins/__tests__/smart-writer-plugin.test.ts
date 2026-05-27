import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemorySmartWriterPlugin } from '../smart-writer-plugin';
import type { BaseChatModel, ChatMessage, ChatResponse, ChatStreamChunk, Embedder, Interceptor, InterceptorContext } from 'flopsygraph';

function ctx(): InterceptorContext {
    return { runId: 'r', threadId: 't', configurable: {}, store: new Map() };
}

class StubEmbedder implements Embedder {
    readonly dimensions = 8;
    async embed(text: string): Promise<number[]> {
        const v = new Array(8).fill(0);
        const t = text.toLowerCase();
        if (t.includes('tokyo') || t.includes('japan') || t.includes('berlin')) v[0] = 1;
        if (t.includes('comedy') || t.includes('chappelle') || t.includes('jokes')) v[1] = 1;
        if (t.includes('postgres') || t.includes('database')) v[2] = 1;
        const sum = v.reduce((a, b) => a + b, 0) || 1;
        return v.map((x) => x / Math.sqrt(sum));
    }
    async embedBatch(texts: string[]): Promise<number[][]> {
        return Promise.all(texts.map((t) => this.embed(t)));
    }
}

class StubModel {
    readonly provider = 'stub';
    readonly model = 'stub-model';
    nextResponse: string = JSON.stringify({ decision: 'ADD', target_idx: null, merged: null, reason: 'stub' });

    async invoke(_messages: readonly ChatMessage[]): Promise<ChatResponse> {
        return {
            content: this.nextResponse,
            stopReason: 'end',
        } as ChatResponse;
    }
    async *stream(): AsyncIterable<ChatStreamChunk> { yield { content: '', done: true }; }
    bindTools(): unknown { return this; }
    withStructuredOutput(): never { throw new Error('not implemented'); }
}

describe('MemorySmartWriterPlugin', () => {
    let dir: string;
    let auditLog: string;
    let plugin: Interceptor;
    let model: StubModel;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'flopsy-smart-test-'));
        auditLog = join(dir, 'audit.jsonl');
        model = new StubModel();
        plugin = createMemorySmartWriterPlugin({
            model: 'nvidia:google/gemma-4-31b-it',
            embedder: new StubEmbedder(),
            dbPath: join(dir, 'smart-index.db'),
            similarityThreshold: 0.5,
            topK: 3,
            auditLog,
            apiKey: 'test-key',
            modelInstance: model as unknown as BaseChatModel,
        });
    });

    afterEach(() => {
        try { plugin.teardown?.({} as never); } catch { /* */ }
        rmSync(dir, { recursive: true, force: true });
    });

    it('exposes smart_remember tool with rich description', () => {
        expect(plugin.tools).toBeDefined();
        expect(plugin.tools!.length).toBe(1);
        expect(plugin.tools![0]!.name).toBe('smart_remember');
        const desc = plugin.tools![0]!.description!;
        expect(desc).toMatch(/DECISION PROCESS/);
        expect(desc).toMatch(/WHEN TO USE/);
        expect(desc).toMatch(/WHEN NOT TO USE/);
        expect(desc).toMatch(/ADD/);
        expect(desc).toMatch(/UPDATE/);
        expect(desc).toMatch(/DELETE/);
        expect(desc).toMatch(/NOOP/);
        expect(desc.length).toBeGreaterThan(800);
    });

    it('ADD fast-path: empty index → no LLM call, just adds', async () => {
        const tool = plugin.tools![0]!;
        const out = JSON.parse((await tool.execute(
            { content: 'Location: Tokyo', target: 'user' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.decision).toBe('ADD');
        expect(out.action_applied).toBe('add');
        expect(out.candidates_considered).toBe(0);
        expect(out.reason).toMatch(/no existing entry/);
    });

    it('ADD fast-path: candidates exist but below threshold → adds without LLM', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Comedy: Dave Chappelle', undefined, ctx());
        const tool = plugin.tools![0]!;
        const out = JSON.parse((await tool.execute(
            { content: 'Location: Tokyo', target: 'user' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.decision).toBe('ADD');
        expect(out.candidates_considered).toBe(0);
    });

    it('UPDATE: LLM picks UPDATE for refining content', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Location: Berlin', undefined, ctx());
        model.nextResponse = JSON.stringify({
            decision: 'UPDATE',
            target_idx: 0,
            merged: 'Location: Tokyo',
            reason: 'User moved from Berlin to Tokyo; supersedes the old fact',
        });
        const tool = plugin.tools![0]!;
        const out = JSON.parse((await tool.execute(
            { content: 'I moved to Tokyo last week', target: 'user' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.decision).toBe('UPDATE');
        expect(out.action_applied).toBe('replace');
        expect(out.merged_content).toBe('Location: Tokyo');
        expect(out.reason).toMatch(/Tokyo/);
    });

    it('NOOP: LLM says fact already captured → no write', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Entertainment: Stand-up comedy; favorite Dave Chappelle', undefined, ctx());
        model.nextResponse = JSON.stringify({
            decision: 'NOOP',
            target_idx: 0,
            merged: null,
            reason: 'Already implied by existing comedy entry',
        });
        const tool = plugin.tools![0]!;
        const out = JSON.parse((await tool.execute(
            { content: 'User likes jokes', target: 'user' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.decision).toBe('NOOP');
        expect(out.action_applied).toBe('noop');
    });

    it('DELETE: LLM says new content invalidates an old one', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Postgres: prefers raw SQL over Prisma', undefined, ctx());
        model.nextResponse = JSON.stringify({
            decision: 'DELETE',
            target_idx: 0,
            merged: null,
            reason: 'User explicitly retracted old preference',
        });
        const tool = plugin.tools![0]!;
        const out = JSON.parse((await tool.execute(
            { content: 'User just retracted their Postgres preference', target: 'user' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.decision).toBe('DELETE');
        expect(out.action_applied).toBe('remove');
    });

    it('appends an audit entry on every decision', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Comedy: Dave Chappelle', undefined, ctx());
        const tool = plugin.tools![0]!;
        await tool.execute(
            { content: 'Location: Tokyo', target: 'user' } as never,
            { signal: new AbortController().signal },
        );
        expect(existsSync(auditLog)).toBe(true);
        const lines = readFileSync(auditLog, 'utf8').split('\n').filter(Boolean);
        expect(lines.length).toBe(1);
        const entry = JSON.parse(lines[0]!);
        expect(entry.target).toBe('user');
        expect(entry.decision).toBe('ADD');
        expect(entry.actionApplied).toBe('add');
        expect(typeof entry.elapsedMs).toBe('number');
    });

    it('falls back to plain ADD when LLM call fails', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Comedy: Dave Chappelle', undefined, ctx());
        model.invoke = async () => { throw new Error('network failure'); };
        const tool = plugin.tools![0]!;
        const out = JSON.parse((await tool.execute(
            { content: 'User likes jokes comedy', target: 'user' } as never,
            { signal: new AbortController().signal },
        )) as string);
        expect(out.decision).toBe('ADD');
        expect(out.action_applied).toBe('add');
        expect(out.error).toBe(true);
    });

    it('keeps its own SQLite mirror in sync via onMemoryWrite', async () => {
        await plugin.onMemoryWrite!('add', 'memory', 'Bytepesa Postgres 16', undefined, ctx());
        await plugin.onMemoryWrite!('add', 'memory', 'Bytepesa Prisma ORM', undefined, ctx());

        const tool = plugin.tools![0]!;
        await tool.execute(
            { content: 'Postgres database for Bytepesa', target: 'memory' } as never,
            { signal: new AbortController().signal },
        );
        const lines = readFileSync(auditLog, 'utf8').split('\n').filter(Boolean);
        const entry = JSON.parse(lines[lines.length - 1]!);
        expect(entry.candidatesSimilarities.length).toBeGreaterThan(0);
    });
});
