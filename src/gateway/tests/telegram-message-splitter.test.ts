import { describe, it, expect } from 'vitest';
import {
    splitMessage,
    splitForTelegram,
    TELEGRAM_MAX_LENGTH,
    DISCORD_MAX_LENGTH,
} from '../src/channels/telegram/message-splitter';

const FENCE_MARKER_RE = /\(\d+\/\d+\)\s*$/;

describe('splitMessage', () => {
    it('returns the body unchanged when it fits in the budget', () => {
        expect(splitMessage('short message')).toEqual(['short message']);
    });

    it('splits a long body on line boundaries and stays within budget', () => {
        const body = Array.from({ length: 800 }, (_, i) => `line ${i}: ${'x'.repeat(40)}`).join('\n');
        const chunks = splitMessage(body, 1000);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    });

    it('appends (N/M) pagination markers when chunks > 1', () => {
        const body = 'x'.repeat(2000);
        const chunks = splitMessage(body, 500);
        expect(chunks.length).toBeGreaterThan(1);
        for (let i = 0; i < chunks.length; i++) {
            expect(chunks[i]).toMatch(new RegExp(`\\(${i + 1}/${chunks.length}\\)\\s*$`));
        }
    });

    it('omits markers when the body fits in one chunk', () => {
        const body = 'short reply';
        const chunks = splitMessage(body, 1000);
        expect(chunks).toEqual(['short reply']);
        expect(chunks[0]).not.toMatch(FENCE_MARKER_RE);
    });

    it('preserves an open code fence by closing on this chunk and reopening with the language on the next', () => {
        const inner = Array.from({ length: 60 }, (_, i) => `print(${i})`).join('\n');
        const body = '```python\n' + inner + '\n```';
        const chunks = splitMessage(body, 400);
        expect(chunks.length).toBeGreaterThan(1);

        // First chunk must close the fence it opened.
        expect(chunks[0]).toMatch(/```python\n/);
        expect(chunks[0]).toMatch(/```\s+\(\d+\/\d+\)\s*$/);

        // Middle chunks (if any) must reopen with the language, then close.
        for (let i = 1; i < chunks.length - 1; i++) {
            expect(chunks[i]).toMatch(/^```python\n/);
            expect(chunks[i]).toMatch(/```\s+\(\d+\/\d+\)\s*$/);
        }

        // Final chunk must reopen with the language and end with a closing
        // ``` from the original body — followed by the (N/M) marker.
        const last = chunks[chunks.length - 1];
        expect(last).toMatch(/^```python\n/);
        expect(last).toMatch(/```\s+\(\d+\/\d+\)\s*$/);
    });

    it('guards against splitting inside a balanced inline backtick span', () => {
        // Body has a balanced `hello world span` whose midpoint lines up
        // with the natural split window. The guard must retreat before
        // the opening backtick so neither chunk ships an unbalanced span.
        const before = 'x'.repeat(440);
        const span   = '`hello world span`';   // balanced inline span
        const after  = 'y'.repeat(440);
        const body   = `${before} ${span} ${after}`;
        const chunks = splitMessage(body, 500);
        expect(chunks.length).toBeGreaterThan(1);

        // The first chunk must end with an even backtick count.
        const stripped = chunks[0].replace(/\(\d+\/\d+\)\s*$/, '');
        const tickCount = (stripped.match(/(?<!\\)`/g) ?? []).length;
        expect(tickCount % 2).toBe(0);
    });

    it('hard-slices a single line that itself exceeds the budget', () => {
        const monster = 'x'.repeat(10_000);
        const chunks = splitMessage(monster, 1000);
        expect(chunks.length).toBeGreaterThanOrEqual(10);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    });

    it('respects per-platform budgets via maxLength', () => {
        const body = 'x'.repeat(3000);
        const tg = splitMessage(body, TELEGRAM_MAX_LENGTH);
        const dc = splitMessage(body, DISCORD_MAX_LENGTH);
        expect(tg.length).toBe(1);                          // 3000 <= 4096
        expect(dc.length).toBeGreaterThan(1);               // 3000 > 2000 → chunked
        for (const c of dc) expect(c.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH);
    });

    it('exposes a backwards-compatible splitForTelegram alias', () => {
        const body = 'x'.repeat(50);
        expect(splitForTelegram(body)).toEqual(splitMessage(body, TELEGRAM_MAX_LENGTH));
    });
});
