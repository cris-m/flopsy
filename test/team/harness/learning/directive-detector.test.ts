/**
 * directive-detector — classifies user messages as durable preferences.
 *
 * False positives matter: misclassifying mid-clause "I always wondered" as a
 * directive would write spurious lessons. False negatives matter too: missing
 * "always include sources" leaves the agent ignoring corrections forever.
 */
import { describe, expect, it } from 'vitest';
import { detectDirective } from '@flopsy/team/harness/learning/directive-detector';

describe('detectDirective', () => {
    describe('classifies as directive', () => {
        const positives = [
            'always include source links',
            'never use bullet points',
            "don't repeat the question back to me",
            'stop using emoji',
            'from now on, reply in french',
            'going forward, keep responses under 200 words',
            'Always cite a URL.',
            'NEVER hallucinate data',
            'please always format with headings',
        ];

        for (const text of positives) {
            it(`matches: ${JSON.stringify(text)}`, () => {
                const fb = detectDirective(text);
                expect(fb).toBeDefined();
                expect(fb!.explicit?.type).toBe('correction');
                expect(fb!.explicit?.text.length).toBeGreaterThan(0);
            });
        }

        it('strips a leading quote/bracket prefix', () => {
            // Quoted-reply formatting ("> always include sources") is a
            // common shape — should still match.
            expect(detectDirective('> always include sources')).toBeDefined();
        });
    });

    describe('does not classify as directive', () => {
        const negatives = [
            'I always wondered why this happens',
            'never mind, figured it out',
            'stop the war',                 // not a "stop X-ing" directive shape
            "I don't know what to do",
            'how does this work?',
            "what's the latest news",
            '',
            '   ',
        ];

        for (const text of negatives) {
            it(`ignores: ${JSON.stringify(text)}`, () => {
                expect(detectDirective(text)).toBeUndefined();
            });
        }
    });

    describe('feedback shape', () => {
        it('returns text with the cleaned message (no leading punctuation)', () => {
            const fb = detectDirective('  >> always include source links');
            expect(fb?.explicit?.text).toBe('always include source links');
        });

        it('returns type=correction (drives the lesson-write branch)', () => {
            const fb = detectDirective('never repeat the question');
            expect(fb?.explicit?.type).toBe('correction');
        });
    });
});
