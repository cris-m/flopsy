/**
 * normalizeErrorPattern — shape-stable summary of a tool error string.
 *
 * Two failures from the same root cause must collapse to the same pattern,
 * so the (peer, tool, pattern) UPSERT key in `tool_failures` actually
 * counts repeats instead of fragmenting one error class across many rows.
 */
import { describe, expect, it } from 'vitest';
import { normalizeErrorPattern } from '@flopsy/team/harness/learning/error-patterns';

describe('normalizeErrorPattern', () => {
    describe('grouping equivalence', () => {
        it('collapses two errors that differ only in path', () => {
            const a = normalizeErrorPattern("ENOENT: no such file or directory, open '/Users/alice/notes.md'");
            const b = normalizeErrorPattern("ENOENT: no such file or directory, open '/Users/bob/draft.md'");
            // Quoted strings of length ≥12 are masked to <str>; the ENOENT
            // class plus the "no such file" prefix is what we want to count.
            expect(a).toBe(b);
        });

        it('collapses two errors that differ only in long numeric IDs', () => {
            const a = normalizeErrorPattern('Failed to fetch: status 429 for request 873420198345');
            const b = normalizeErrorPattern('Failed to fetch: status 429 for request 998123007734');
            expect(a).toBe(b);
        });

        it('collapses errors differing only in hex addresses', () => {
            const a = normalizeErrorPattern('Segfault at 0xdeadbeef while flushing');
            const b = normalizeErrorPattern('Segfault at 0xcafebabe while flushing');
            expect(a).toBe(b);
        });
    });

    describe('content preservation', () => {
        it('keeps short HTTP status codes (signal-bearing)', () => {
            const out = normalizeErrorPattern('HTTP 429 rate limited');
            expect(out).toContain('429');
        });

        it('keeps the leading error class word', () => {
            const out = normalizeErrorPattern('ECONNREFUSED 127.0.0.1:8080 — bridge down');
            expect(out).toContain('ECONNREFUSED');
        });

        it('does not over-collapse: distinct error classes stay distinct', () => {
            const a = normalizeErrorPattern('Request failed with 429 Too Many Requests');
            const b = normalizeErrorPattern('Request failed with 503 Service Unavailable');
            expect(a).not.toBe(b);
        });
    });

    describe('shape', () => {
        it('keeps only the first line (drops stack traces)', () => {
            const raw = [
                'TypeError: cannot read property foo',
                '    at fn (file.ts:12)',
                '    at Module._compile',
            ].join('\n');
            const out = normalizeErrorPattern(raw);
            expect(out).not.toContain('at fn');
            expect(out).not.toContain('Module._compile');
        });

        it('caps length at 120 characters', () => {
            const long = 'Error: ' + 'x'.repeat(500);
            expect(normalizeErrorPattern(long).length).toBeLessThanOrEqual(120);
        });

        it('returns empty string for empty/whitespace input', () => {
            expect(normalizeErrorPattern('')).toBe('');
            expect(normalizeErrorPattern('   ')).toBe('');
        });

        it('trims surrounding whitespace', () => {
            expect(normalizeErrorPattern('   ECONNREFUSED   ')).toBe('ECONNREFUSED');
        });
    });
});
