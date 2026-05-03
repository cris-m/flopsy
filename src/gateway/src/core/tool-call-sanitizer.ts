/**
 * Strip stray tool-call format leaked into assistant prose. Conservative —
 * only patterns that are unambiguously tool-call shaped; user-authored JSON
 * with the same exact key combinations is exceedingly rare. Pure, idempotent.
 */

// FlopsyBot DCL plumbing leaked as text.
const META_TOOL_CALL_LINE = /^[ \t]*__(search_tools|load_tool|respond)__\s*\([^)]*\)\s*$/gm;

// OpenAI-shaped function call dumped as message content.
const OPENAI_TOOL_CALL = /\{[\s\n]*"type"\s*:\s*"function"[\s\S]*?"name"\s*:\s*"[a-zA-Z0-9_]+"[\s\S]*?\}/g;

// Anthropic-shaped tool_use block leaked as text (misconfigured stream parser).
const ANTHROPIC_TOOL_USE = /\{[\s\n]*"type"\s*:\s*"tool_use"[\s\S]*?"name"\s*:\s*"[a-zA-Z0-9_]+"[\s\S]*?\}/g;

export function stripToolCallNoise(text: string): string {
    if (!text) return text;
    let out = text;

    // Order: meta-tool first (single-line, constrained); JSON shapes are
    // greedier and could over-match if applied first.
    out = out.replace(META_TOOL_CALL_LINE, '');
    out = out.replace(OPENAI_TOOL_CALL, '');
    out = out.replace(ANTHROPIC_TOOL_USE, '');

    // Cap at TWO blank lines so paragraph breaks survive.
    out = out.replace(/\n{3,}/g, '\n\n');

    return out.trim() || text;
}
