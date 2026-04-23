import type { MessageRow } from '../storage';

/**
 * System prompt for the background skill reviewer.
 * Kept tightly scoped: single JSON response that extracts both a skill and user facts.
 */
export const REVIEWER_SYSTEM = `You are a learning assistant for a personal AI system called Flopsy.

Your job has two parts — do BOTH in a single JSON response:

## Part 1 — Skill extraction

Read the conversation and decide whether it demonstrates a REUSABLE procedure worth capturing as a SKILL.md.

A skill is worth capturing when:
- The agent used a multi-step process that worked well and will recur
- The user corrected a repeated mistake — the fix should be codified
- A domain-specific workflow emerged that is non-obvious and reusable

Do NOT capture: one-off tasks, general knowledge, anything obvious from the agent's role.

## Part 2 — User preference facts

Extract 0–5 observable facts about the user's preferences from the conversation.
Only extract what is CLEARLY EVIDENT — do not infer or guess.

Valid fact predicates (use exactly these strings):
- prefers_format         (e.g. "bullet points", "numbered lists", "prose paragraphs")
- communication_style    (e.g. "terse", "detailed", "uses technical jargon")
- domain_interest        (e.g. "quantitative finance", "machine learning", "home automation")
- response_length_pref   (e.g. "concise", "thorough")
- timezone               (e.g. "Europe/Paris")
- language_pref          (e.g. "French preferred for casual messages")

Respond with a raw JSON object (no markdown fences):

{
  "shouldWrite": true | false,
  "skillName": "kebab-case-name",
  "skillContent": "full SKILL.md content",
  "facts": [
    { "predicate": "prefers_format", "object": "bullet points" }
  ]
}

skillName and skillContent are ONLY required when shouldWrite=true.
facts may be an empty array when nothing is clearly evident.

CRITICAL: When shouldWrite=true, skillContent MUST start with this YAML frontmatter.
The "name" value in the frontmatter MUST be IDENTICAL to the skillName field above.
If they differ, the skill is silently dropped by the indexer.

---
name: <EXACT same string as skillName field above>
description: <one-line what it does, max 200 chars>
tags: [<tag1>, <tag2>]
---

## When to use
<1-2 sentences>

## Steps
1. ...
2. ...

## Notes
- <any gotchas>`;

/**
 * Build the user message for the reviewer: a compact conversation snapshot.
 * Keeps the payload small — we only need enough context for the LLM to
 * identify whether a reusable procedure appeared.
 */
export function buildReviewPrompt(messages: MessageRow[]): string {
    if (messages.length === 0) return 'No messages to review.';

    const lines: string[] = ['<conversation_snapshot>'];
    for (const m of messages) {
        const role = m.role === 'assistant' ? 'Agent' : 'User';
        // Truncate long assistant turns to avoid prompt bloat.
        const body =
            m.role === 'assistant' && m.content.length > 600
                ? `${m.content.slice(0, 600)}…`
                : m.content;
        lines.push(`[${role}] ${body}`);
    }
    lines.push('</conversation_snapshot>');
    lines.push('');
    lines.push(
        'Analyse this snippet. Is there a reusable procedure worth capturing as a SKILL.md? Reply with JSON.',
    );
    return lines.join('\n');
}

export interface ReviewFact {
    predicate: string;
    object: string;
}

export interface ReviewDecision {
    shouldWrite: boolean;
    skillName?: string;
    skillContent?: string;
    facts: ReviewFact[];
}

const ALLOWED_PREDICATES = new Set([
    'prefers_format',
    'communication_style',
    'domain_interest',
    'response_length_pref',
    'timezone',
    'language_pref',
]);

export function parseReviewResponse(raw: string): ReviewDecision {
    const trimmed = raw.trim();
    const empty: ReviewDecision = { shouldWrite: false, facts: [] };
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed !== 'object' || parsed === null) return empty;
        const obj = parsed as Record<string, unknown>;

        // Parse facts — validate predicate allowlist and truncate object strings.
        const rawFacts = Array.isArray(obj['facts']) ? obj['facts'] : [];
        const facts: ReviewFact[] = rawFacts
            .filter(
                (f): f is { predicate: string; object: string } =>
                    typeof f === 'object' &&
                    f !== null &&
                    typeof (f as Record<string, unknown>)['predicate'] === 'string' &&
                    typeof (f as Record<string, unknown>)['object'] === 'string',
            )
            .filter((f) => ALLOWED_PREDICATES.has(f.predicate))
            .map((f) => ({ predicate: f.predicate, object: String(f.object).slice(0, 200) }))
            .slice(0, 5);

        if (obj['shouldWrite'] !== true) return { shouldWrite: false, facts };

        const skillName = typeof obj['skillName'] === 'string' ? obj['skillName'].trim() : '';
        const skillContent =
            typeof obj['skillContent'] === 'string' ? obj['skillContent'].trim() : '';
        if (!skillName || !skillContent) return { shouldWrite: false, facts };

        // Sanitize skill name: only lowercase letters, digits, hyphens.
        const safeName = skillName.replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-');
        return { shouldWrite: true, skillName: safeName, skillContent, facts };
    } catch {
        return empty;
    }
}
