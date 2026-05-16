import type { UserFeedback } from '@shared/types';

// Patterns marking a user message as a durable directive (anchored to message start).
const DIRECTIVE_PATTERNS: ReadonlyArray<RegExp> = [
    /^(?:please[,\s]+)?always\b/i,
    /^(?:please[,\s]+)?never\b/i,
    /^stop\s+(?:doing|using|writing|saying)\b/i,
    /^don'?t\s+(?:ever\s+)?(?:do|use|write|say|reply|respond|repeat|include|forget)\b/i,
    /^from\s+now\s+on\b/i,
    /^going\s+forward\b/i,
];

// Idioms that match a directive prefix but aren't directives (e.g. "never mind").
const DIRECTIVE_DENYLIST: ReadonlyArray<RegExp> = [
    /^never\s+mind\b/i,
];

/**
 * Classify a user message as a durable directive (returns UserFeedback)
 * or undefined when none of the patterns match.
 */
export function detectDirective(userText: string): UserFeedback | undefined {
    if (!userText) return undefined;
    // Strip leading quote/bracket/punctuation so ">>> always include sources" still matches.
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
