import type { UserFeedback } from '@shared/types';

// Patterns that mark a user message as a *directive* — a durable preference
// the agent should obey on every future turn (not a one-off question).
//
// Anchored to the message start so casual sentences mentioning "always" or
// "never" mid-clause ("I always wondered…", "never mind") aren't misclassified.
// Stripped of leading punctuation/whitespace so polite "please, always …"
// still matches.
const DIRECTIVE_PATTERNS: ReadonlyArray<RegExp> = [
    /^(?:please[,\s]+)?always\b/i,
    /^(?:please[,\s]+)?never\b/i,
    /^stop\s+(?:doing|using|writing|saying)\b/i,
    /^don'?t\s+(?:ever\s+)?(?:do|use|write|say|reply|respond|repeat|include|forget)\b/i,
    /^from\s+now\s+on\b/i,
    /^going\s+forward\b/i,
];

// Idioms that match a directive prefix but aren't directives. "never mind" =
// dismissal, not a rule. Keep this list tight — every entry trades a false
// negative for a false-positive avoided.
const DIRECTIVE_DENYLIST: ReadonlyArray<RegExp> = [
    /^never\s+mind\b/i,
];

/**
 * Classify a user message as a directive (durable preference) or undefined.
 * When matched, returns a `UserFeedback` whose `explicit.type === 'correction'`;
 * the harness interceptor reads that branch and persists the rule via
 * `learningStore.insertDirective()`.
 *
 * Returns undefined for messages that don't look like directives — caller
 * should fall through to whatever default behaviour applies.
 */
export function detectDirective(userText: string): UserFeedback | undefined {
    if (!userText) return undefined;
    // Strip a single leading quote/bracket/punctuation block so things like
    // ">>> always include sources" still match. Then trim.
    const cleaned = userText.replace(/^[\s>"'`*\-–—•]+/, '').trim();
    if (cleaned.length === 0) return undefined;

    for (const deny of DIRECTIVE_DENYLIST) {
        if (deny.test(cleaned)) return undefined;
    }

    for (const pat of DIRECTIVE_PATTERNS) {
        if (pat.test(cleaned)) {
            return {
                explicit: {
                    type: 'correction',
                    text: cleaned,
                },
            };
        }
    }
    return undefined;
}
