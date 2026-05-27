import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryAuditPlugin } from '../audit-plugin';
import type { Interceptor, InterceptorContext, MemoryResult } from 'flopsygraph';

function ctx(): InterceptorContext {
    return { runId: 'r', threadId: 't', configurable: {}, store: new Map() };
}

describe('MemoryAuditPlugin', () => {
    let dir: string;
    let logPath: string;
    let plugin: Interceptor;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'flopsy-audit-test-'));
        logPath = join(dir, 'audit.jsonl');
        plugin = createMemoryAuditPlugin({ logPath, maxQueryResults: 50 });
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('exposes the memory_audit_query tool', () => {
        expect(plugin.tools).toBeDefined();
        expect(plugin.tools!.length).toBe(1);
        expect(plugin.tools![0]!.name).toBe('memory_audit_query');
    });

    it('appends a write event when onMemoryWrite fires', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Location: Tokyo', { ts: 1, source: 'test' }, ctx());
        const raw = readFileSync(logPath, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        expect(lines).toHaveLength(1);
        const evt = JSON.parse(lines[0]!);
        expect(evt.kind).toBe('write');
        expect(evt.action).toBe('add');
        expect(evt.target).toBe('user');
        expect(evt.contentPreview).toBe('Location: Tokyo');
    });

    it('appends a read event when onMemoryRead fires', async () => {
        const results: MemoryResult[] = [
            { id: '1', namespace: 'user', content: 'x', createdAt: 0, updatedAt: 0 },
            { id: '2', namespace: 'user', content: 'y', createdAt: 0, updatedAt: 0 },
        ];
        await plugin.onMemoryRead!('tokyo', 'user', results, ctx());
        const raw = readFileSync(logPath, 'utf8');
        const evt = JSON.parse(raw.split('\n').filter(Boolean)[0]!);
        expect(evt.kind).toBe('read');
        expect(evt.namespace).toBe('user');
        expect(evt.resultCount).toBe(2);
        expect(evt.query).toBe('tokyo');
    });

    it('truncates long content to a preview', async () => {
        const huge = 'A'.repeat(500);
        await plugin.onMemoryWrite!('add', 'memory', huge, undefined, ctx());
        const evt = JSON.parse(readFileSync(logPath, 'utf8').split('\n').filter(Boolean)[0]!);
        expect(evt.contentPreview.length).toBeLessThanOrEqual(201);
        expect(evt.contentPreview.endsWith('…')).toBe(true);
    });

    it('audit query: returns empty result when log absent', async () => {
        const tool = plugin.tools![0]!;
        const out = await tool.execute({ kind: 'all', limit: 20 } as never, { signal: new AbortController().signal });
        const parsed = JSON.parse(typeof out === 'string' ? out : JSON.stringify(out));
        expect(parsed.events).toEqual([]);
    });

    it('audit query: filters by kind', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'fact A', undefined, ctx());
        await plugin.onMemoryRead!('q', 'user', [], ctx());
        await plugin.onMemoryWrite!('replace', 'memory', 'fact B', undefined, ctx());

        const tool = plugin.tools![0]!;
        const writes = JSON.parse(await tool.execute({ kind: 'write' } as never, { signal: new AbortController().signal }) as string);
        expect(writes.events.length).toBe(2);
        expect(writes.events.every((e: { kind: string }) => e.kind === 'write')).toBe(true);

        const reads = JSON.parse(await tool.execute({ kind: 'read' } as never, { signal: new AbortController().signal }) as string);
        expect(reads.events.length).toBe(1);
        expect(reads.events[0]!.kind).toBe('read');
    });

    it('audit query: filters by target', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'fact A', undefined, ctx());
        await plugin.onMemoryWrite!('add', 'memory', 'fact B', undefined, ctx());

        const tool = plugin.tools![0]!;
        const userOnly = JSON.parse(await tool.execute({ kind: 'write', target: 'user' } as never, { signal: new AbortController().signal }) as string);
        expect(userOnly.events.length).toBe(1);
        expect(userOnly.events[0]!.target).toBe('user');
    });

    it('audit query: grep substring match against content', async () => {
        await plugin.onMemoryWrite!('add', 'user', 'Location: Tokyo', undefined, ctx());
        await plugin.onMemoryWrite!('add', 'user', 'Location: Berlin', undefined, ctx());
        await plugin.onMemoryWrite!('add', 'memory', 'Project: Bytepesa', undefined, ctx());

        const tool = plugin.tools![0]!;
        const tokyo = JSON.parse(await tool.execute({ kind: 'write', grep: 'Tokyo' } as never, { signal: new AbortController().signal }) as string);
        expect(tokyo.events.length).toBe(1);
        expect(tokyo.events[0]!.contentPreview).toContain('Tokyo');
    });

    it('audit query: respects limit and returns newest first', async () => {
        for (let i = 0; i < 5; i++) {
            await plugin.onMemoryWrite!('add', 'memory', `fact ${i}`, undefined, ctx());
        }
        const tool = plugin.tools![0]!;
        const slice = JSON.parse(await tool.execute({ kind: 'write', limit: 3 } as never, { signal: new AbortController().signal }) as string);
        expect(slice.events.length).toBe(3);
        expect(slice.events[0]!.contentPreview).toBe('fact 4');
        expect(slice.events[1]!.contentPreview).toBe('fact 3');
        expect(slice.events[2]!.contentPreview).toBe('fact 2');
    });
});
