import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileMemoryProvider } from '../file-provider';

function makeProvider(dir: string) {
    return new FileMemoryProvider({
        userPath: join(dir, 'USER.md'),
        memoryPath: join(dir, 'MEMORY.md'),
        userCharLimit: 100_000,
        memoryCharLimit: 100_000,
    });
}

async function callTool(
    tool: ReturnType<FileMemoryProvider['getTools']>[number],
    args: Record<string, unknown>,
): Promise<{ success: boolean; error?: string; entry_count?: number }> {
    const ctrl = new AbortController();
    const out = await tool.execute(args as never, { signal: ctrl.signal });
    return JSON.parse(typeof out === 'string' ? out : JSON.stringify(out));
}

describe('FileMemoryProvider file-lock safety', () => {
    let dir: string;
    let provider: FileMemoryProvider;
    let memoryTool: ReturnType<FileMemoryProvider['getTools']>[number];

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'flopsy-lock-test-'));
        provider = makeProvider(dir);
        const tools = provider.getTools();
        const t = tools.find((x) => x.name === 'memory');
        if (!t) throw new Error('memory tool not found');
        memoryTool = t;
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('preserves every write under N concurrent add calls', async () => {
        const N = 20;
        const promises = Array.from({ length: N }, (_, i) =>
            callTool(memoryTool, {
                action: 'add',
                target: 'memory',
                content: `concurrent entry ${i.toString().padStart(3, '0')}`,
            }),
        );
        const results = await Promise.all(promises);
        const successes = results.filter((r) => r.success).length;

        const content = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
        const onDisk = content.split('\n\n').filter(Boolean).length;

        expect(onDisk).toBe(successes);
        expect(successes).toBe(N);
    });

    it('cleans up the lockfile after each write', async () => {
        await callTool(memoryTool, { action: 'add', target: 'memory', content: 'one entry' });
        const lockPath = join(dir, 'MEMORY.md.lock');
        expect(existsSync(lockPath)).toBe(false);
    });

    it('recovers from a stale lockfile (>30s old)', async () => {
        const lockPath = join(dir, 'MEMORY.md.lock');
        await writeFile(lockPath, '');
        const staleAge = (Date.now() - 60_000) / 1000;
        await utimes(lockPath, staleAge, staleAge);

        const t0 = Date.now();
        const r = await callTool(memoryTool, {
            action: 'add',
            target: 'memory',
            content: 'post-stale-lock entry',
        });
        const elapsed = Date.now() - t0;

        expect(r.success).toBe(true);
        expect(elapsed).toBeLessThan(1500);
        expect(existsSync(lockPath)).toBe(false);
    });

    it('fires onMemoryWrite for every successful write action', async () => {
        const events: Array<{ action: string; target: string; content: string }> = [];
        const provider2 = new FileMemoryProvider({
            userPath: join(dir, 'USER.md'),
            memoryPath: join(dir, 'MEMORY.md'),
            userCharLimit: 100_000,
            memoryCharLimit: 100_000,
            onMemoryWrite: async (action, target, content) => {
                events.push({ action, target, content });
            },
        });
        const tool = provider2.getTools().find((t) => t.name === 'memory')!;

        await callTool(tool, { action: 'add', target: 'memory', content: 'fact one' });
        await callTool(tool, { action: 'upsert', target: 'user', key: 'Location', content: 'Location: Tokyo' });
        await callTool(tool, { action: 'replace', target: 'memory', old_text: 'fact one', content: 'fact one revised' });
        await callTool(tool, { action: 'remove', target: 'memory', old_text: 'fact one revised' });

        expect(events.map((e) => e.action)).toEqual(['add', 'upsert', 'replace', 'remove']);
        expect(events[0]!.content).toBe('fact one');
        expect(events[1]!.content).toBe('Location: Tokyo');
        expect(events[2]!.content).toBe('fact one revised');
        expect(events[3]!.content).toBe('fact one revised');
    });

    it('does NOT fire onMemoryWrite when a write is refused (validation failure)', async () => {
        const events: string[] = [];
        const provider2 = new FileMemoryProvider({
            userPath: join(dir, 'USER.md'),
            memoryPath: join(dir, 'MEMORY.md'),
            userCharLimit: 100_000,
            memoryCharLimit: 100_000,
            onMemoryWrite: async (action) => { events.push(action); },
        });
        const tool = provider2.getTools().find((t) => t.name === 'memory')!;

        await callTool(tool, { action: 'add', target: 'memory', content: 'same fact' });
        const dupResult = await callTool(tool, { action: 'add', target: 'memory', content: 'same fact' });
        expect(dupResult.success).toBe(false);
        const removeMissResult = await callTool(tool, { action: 'remove', target: 'memory', old_text: 'never existed' });
        expect(removeMissResult.success).toBe(false);

        expect(events).toEqual(['add']);
    });

    it('preserves writes across two separate provider instances (cross-process simulation)', async () => {
        const providerB = makeProvider(dir);
        const memoryToolB = providerB.getTools().find((t) => t.name === 'memory')!;

        const ops = [
            ...Array.from({ length: 8 }, (_, i) =>
                callTool(memoryTool, {
                    action: 'add',
                    target: 'memory',
                    content: `provider-A entry ${i.toString().padStart(2, '0')}`,
                }),
            ),
            ...Array.from({ length: 8 }, (_, i) =>
                callTool(memoryToolB, {
                    action: 'add',
                    target: 'memory',
                    content: `provider-B entry ${i.toString().padStart(2, '0')}`,
                }),
            ),
        ];
        const results = await Promise.all(ops);
        const successCount = results.filter((r) => r.success).length;

        const content = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
        const entries = content.split('\n\n').filter(Boolean);
        expect(entries.length).toBe(successCount);
        expect(successCount).toBe(16);
    });
});
