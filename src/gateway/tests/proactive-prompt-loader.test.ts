/**
 * PromptLoader — kind-namespacing + ENOENT propagation.
 *
 * The proactive system stores prompts under .flopsy/proactive/<kind>/<file>.
 * Two regressions caused the SEO-snippet incident:
 *   1. callers passed a relative path without `kind` → loader silently fell
 *      back to baseDir → ENOENT → trigger swallowed it → empty prompt.
 *   2. file actually missing → ENOENT → trigger swallowed it → empty prompt.
 *
 * The loader now throws loudly on (1) and lets ENOENT bubble for (2). These
 * tests lock both behaviours in.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptLoader } from '../src/proactive/prompt-loader';

describe('PromptLoader', () => {
    let homeDir: string;
    let prevHome: string | undefined;
    let loader: PromptLoader;

    beforeEach(() => {
        homeDir = mkdtempSync(join(tmpdir(), 'flopsy-prompt-loader-'));
        mkdirSync(join(homeDir, 'proactive', 'heartbeats'), { recursive: true });
        mkdirSync(join(homeDir, 'proactive', 'cron'), { recursive: true });
        prevHome = process.env.FLOPSY_HOME;
        process.env.FLOPSY_HOME = homeDir;
        loader = new PromptLoader(homeDir, 60_000);
    });

    afterEach(() => {
        if (prevHome === undefined) delete process.env.FLOPSY_HOME;
        else process.env.FLOPSY_HOME = prevHome;
        rmSync(homeDir, { recursive: true, force: true });
    });

    it('returns inline prompt when promptFile is undefined', async () => {
        const out = await loader.resolve('inline content', undefined, 'heartbeat');
        expect(out).toBe('inline content');
    });

    it('returns empty string when both prompt and promptFile are undefined', async () => {
        const out = await loader.resolve(undefined, undefined, 'cron');
        expect(out).toBe('');
    });

    it('reads heartbeat file under .flopsy/proactive/heartbeats/', async () => {
        writeFileSync(
            join(homeDir, 'proactive', 'heartbeats', 'pulse.md'),
            '## smart-pulse\nbe terse',
            'utf8',
        );
        const out = await loader.resolve('', 'pulse.md', 'heartbeat');
        expect(out).toContain('smart-pulse');
        expect(out).toContain('be terse');
    });

    it('reads cron file under .flopsy/proactive/cron/', async () => {
        writeFileSync(
            join(homeDir, 'proactive', 'cron', 'morning.md'),
            'morning briefing prompt',
            'utf8',
        );
        const out = await loader.resolve('', 'morning.md', 'cron');
        expect(out).toBe('morning briefing prompt');
    });

    it('throws when relative path is passed without kind (anti-fallthrough guard)', async () => {
        await expect(loader.resolve('', 'pulse.md')).rejects.toThrow(
            /requires a PromptKind/,
        );
    });

    it('does NOT silently fall back to baseDir for un-kinded relative paths', async () => {
        // Place a file directly under baseDir (the OLD silent fallback path).
        writeFileSync(join(homeDir, 'pulse.md'), 'should not be readable', 'utf8');
        await expect(loader.resolve('', 'pulse.md')).rejects.toThrow(
            /requires a PromptKind/,
        );
    });

    it('lets ENOENT bubble up so triggers can skip the fire', async () => {
        // No file written — readFile must throw, not silently return ''.
        await expect(loader.resolve('', 'missing.md', 'heartbeat')).rejects.toThrow(
            /ENOENT/,
        );
    });

    it('caches file content within the TTL window', async () => {
        const path = join(homeDir, 'proactive', 'heartbeats', 'cached.md');
        writeFileSync(path, 'v1', 'utf8');
        const first = await loader.resolve('', 'cached.md', 'heartbeat');
        expect(first).toBe('v1');

        // Mutate file. Within TTL the loader should still serve the cached value.
        writeFileSync(path, 'v2', 'utf8');
        const second = await loader.resolve('', 'cached.md', 'heartbeat');
        expect(second).toBe('v1');
    });

    it('serves fresh content after the TTL elapses', async () => {
        const shortTtl = new PromptLoader(homeDir, 5);
        const path = join(homeDir, 'proactive', 'heartbeats', 'ttl.md');
        writeFileSync(path, 'v1', 'utf8');
        await shortTtl.resolve('', 'ttl.md', 'heartbeat');

        writeFileSync(path, 'v2', 'utf8');
        await new Promise((r) => setTimeout(r, 15));
        const out = await shortTtl.resolve('', 'ttl.md', 'heartbeat');
        expect(out).toBe('v2');
    });

    it('absolute paths bypass kind-namespacing entirely', async () => {
        const abs = join(homeDir, 'absolute.md');
        writeFileSync(abs, 'absolute content', 'utf8');
        const out = await loader.resolve('', abs);
        expect(out).toBe('absolute content');
    });
});
