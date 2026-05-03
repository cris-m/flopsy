/**
 * parseConditionalResponse — turns the agent's `conditional`-mode reply
 * into a structured promote/suppress decision. Wrong here means the
 * proactive engine sends spam (false promote) or swallows real signal
 * (false suppress) — both are user-visible failures.
 *
 * Accepts raw JSON, fenced JSON (```json ... ```), and rejects everything
 * else (returns null) so the executor falls back to "suppress" by default.
 */
import { describe, expect, it } from 'vitest';
import { parseConditionalResponse } from '@flopsy/gateway/proactive';

describe('parseConditionalResponse', () => {
    describe('promote', () => {
        it('parses raw JSON with status: promote', () => {
            const r = parseConditionalResponse(
                '{"status":"promote","reason":"new emails","content":"You have 3 new emails."}',
            );
            expect(r).not.toBeNull();
            expect(r!.status).toBe('promote');
            expect(r!.content).toContain('3 new emails');
        });

        it('parses fenced JSON code block with status: promote', () => {
            const r = parseConditionalResponse([
                'Here is my decision:',
                '```json',
                '{"status":"promote","reason":"sit in attention","content":"Heads up."}',
                '```',
            ].join('\n'));
            expect(r!.status).toBe('promote');
            expect(r!.reason).toBe('sit in attention');
        });
    });

    describe('suppress', () => {
        it('parses raw JSON with status: suppress', () => {
            const r = parseConditionalResponse(
                '{"status":"suppress","reason":"nothing new"}',
            );
            expect(r!.status).toBe('suppress');
            expect(r!.reason).toBe('nothing new');
        });

        it('parses fenced suppress with optional content omitted', () => {
            const r = parseConditionalResponse(
                '```json\n{"status":"suppress","reason":"silent"}\n```',
            );
            expect(r!.status).toBe('suppress');
            // content is optional; should not throw on access
            expect(r!.content).toBeUndefined();
        });
    });

    describe('rejection (returns null)', () => {
        it('returns null on malformed JSON', () => {
            expect(parseConditionalResponse('{not json')).toBeNull();
        });

        it('returns null when status is unknown', () => {
            expect(parseConditionalResponse('{"status":"go-ahead","reason":"x"}'))
                .toBeNull();
        });

        it('returns null when status is missing', () => {
            expect(parseConditionalResponse('{"reason":"x"}')).toBeNull();
        });

        it('returns null when fenced JSON has unknown status', () => {
            expect(parseConditionalResponse('```json\n{"status":"yes"}\n```'))
                .toBeNull();
        });

        it('returns null on plain prose with no JSON', () => {
            expect(parseConditionalResponse('Sure, I will deliver this.'))
                .toBeNull();
        });

        it('returns null on empty input', () => {
            expect(parseConditionalResponse('')).toBeNull();
        });
    });

    describe('robustness', () => {
        it('parses JSON wrapped in surrounding prose (raw fallback path)', () => {
            // Strict JSON.parse fails on prose-wrapped — this falls through
            // to the fenced-extraction branch and finds no fence → null.
            // Documenting current behaviour: callers must wrap in fences.
            const r = parseConditionalResponse(
                'Reasoning: blah\n{"status":"promote","reason":"x","content":"x"}',
            );
            expect(r).toBeNull();
        });

        it('handles fenced JSON with extra whitespace', () => {
            const r = parseConditionalResponse(
                '```json\n  {"status":"promote","reason":"r"}  \n```',
            );
            expect(r!.status).toBe('promote');
        });
    });
});
