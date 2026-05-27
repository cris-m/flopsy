import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileMemoryProvider } from '../file-provider';

function makeProvider(dir: string, memoryCharLimit = 2200) {
    return new FileMemoryProvider({
        userPath: join(dir, 'USER.md'),
        memoryPath: join(dir, 'MEMORY.md'),
        userCharLimit: 1375,
        memoryCharLimit,
    });
}

describe('FileMemoryProvider.ingest (capture write path)', () => {
    let dir: string;
    const read = () => (existsSync(join(dir, 'MEMORY.md')) ? readFileSync(join(dir, 'MEMORY.md'), 'utf8') : '');

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'flopsy-ingest-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('appends distinct facts separated by blank lines, no § delimiter', async () => {
        const p = makeProvider(dir);
        await p.ingest({ kind: 'facts', facts: ['Lives in Goma', 'Prefers concise replies'] });
        const out = read();
        expect(out).toContain('Lives in Goma');
        expect(out).toContain('Prefers concise replies');
        expect(out).not.toContain('§');
        expect(out).toContain('Lives in Goma\n\nPrefers concise replies');
    });

    it('dedups exact-match facts across calls', async () => {
        const p = makeProvider(dir);
        await p.ingest({ kind: 'facts', facts: ['Lives in Goma'] });
        await p.ingest({ kind: 'facts', facts: ['Lives in Goma'] });
        const out = read();
        expect(out.match(/Lives in Goma/g)?.length).toBe(1);
    });

    it('blocks facts that contain a credential (C2)', async () => {
        const p = makeProvider(dir);
        await p.ingest({
            kind: 'facts',
            facts: ['Lives in Goma', 'My Anthropic key is sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA'],
        });
        const out = read();
        expect(out).toContain('Lives in Goma');
        expect(out).not.toContain('sk-ant-');
    });

    it('normalizes internal blank lines so one fact stays one entry (H1)', async () => {
        const p = makeProvider(dir);
        await p.ingest({ kind: 'facts', facts: ['Line one\n\nLine two'] });
        const out = read().trim();
        expect(out).toBe('Line one\nLine two');
    });

    it('skips over-budget facts but keeps ones that fit (M2 continue, not break)', async () => {
        const p = makeProvider(dir, 40);
        await p.ingest({
            kind: 'facts',
            facts: ['short fact', 'X'.repeat(200), 'another short'],
        });
        const out = read();
        expect(out).toContain('short fact');
        expect(out).not.toContain('X'.repeat(200));
        expect(out).toContain('another short');
    });
});
