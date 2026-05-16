import { createLogger } from '@flopsy/shared';
import { z } from 'zod';
import type { BaseChatModel } from 'flopsygraph';
import type { LearningStore } from '../storage/learning-store';
import { emitHook } from '@flopsy/gateway';

const log = createLogger('commitments-extractor');

const TIMEOUT_MS = 60_000;
const RETRY_BACKOFFS_MS = [250, 750] as const;
const MIN_CHARS_TO_EXTRACT = 40;
const MIN_CONFIDENCE = 0.7;
const DEFAULT_MAX_PER_DAY = 3;
// 5min floor satisfies "not same fire" while leaving room for cheap models that
// pick check-in times "soon". The snap-up rescues stragglers just below the floor.
const MIN_DUE_HORIZON_MS = 5 * 60 * 1000;
const SNAP_FLOOR_GRACE_MS = 60 * 60 * 1000;
const MAX_DUE_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

/** Narrower than `ProactiveCommitmentRow`: caller fills identity fields, not the model (anti-injection). */
const CommitmentCandidate = z.object({
    follow_up: z.string().min(8).max(200),
    due_at_ms: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
});

const ExtractorOutput = z.object({
    commitments: z.array(CommitmentCandidate).max(3),
});

export type CommitmentCandidate = z.infer<typeof CommitmentCandidate>;

/** Focused system prompt; negative examples guard against over-extraction. */
function buildExtractorSystem(nowIsoLocal: string, horizonDays: number): string {
    return [
        'You are a focused extractor — NOT a chat agent. Read the latest exchange and',
        'extract follow-up commitments the user did NOT explicitly request.',
        '',
        'A commitment is a conversation-bound future check-in:',
        '  ✓ "I have an interview tomorrow" → check in tomorrow evening',
        "  ✓ \"I'll get back to X by Friday\" → check in Friday afternoon",
        '  ✓ "I\'m exhausted" → gentle check-in tomorrow morning',
        '  ✓ Assistant: "I\'ll follow up once the build finishes" → track that open loop',
        '',
        'NOT a commitment (return empty array for these):',
        '  ✗ "remind me at 3pm" → exact reminder, belongs to cron, not commitments',
        '  ✗ "I had a great day" → no future check-in implied',
        '  ✗ "I noticed X" → observation, not a commitment',
        '  ✗ "thanks" / "ok" / "got it" → conversational ack',
        '  ✗ Anything the user explicitly asked you NOT to follow up on',
        `  ✗ Anything more than ${horizonDays} days out — too far to be conversation-bound`,
        '',
        `Current time: ${nowIsoLocal}.`,
        `The current YEAR is ${new Date(Date.now()).getUTCFullYear()}. When you compute due_at_ms, use this year unless the user explicitly named a different year. NEVER use a year from your training data.`,
        '',
        'Output STRICT JSON matching:',
        '{',
        '  "commitments": [',
        '    {',
        '      "follow_up": "one short sentence the future check-in will lead with",',
        '      "due_at_ms": <epoch milliseconds — when the check-in becomes due>,',
        '      "confidence": <0.0 to 1.0 — be strict, ≥0.7 means you\'d defend it in a postmortem>',
        '    }',
        '  ]',
        '}',
        '',
        'Rules:',
        `- At most 3 commitments per exchange. Most exchanges should produce zero or one.`,
        `- Confidence below 0.7 → omit. We'd rather miss soft signals than spam.`,
        '- due_at_ms must be at least 30 min from "now" — never deliver immediately.',
        `- due_at_ms must be at most ${horizonDays} days from "now".`,
        '- Output JSON ONLY. No commentary. No markdown code fences.',
        '- If nothing qualifies, return {"commitments": []}.',
    ].join('\n');
}

export interface CommitmentsExtractorConfig {
    readonly model: BaseChatModel;
    readonly store: LearningStore;
    readonly maxPerDay?: number;
    readonly minConfidence?: number;
}

export interface ExtractionContext {
    /** Scope key used by smart-pulse for due-commitment lookup. */
    readonly scope: string;
    readonly peerId: string;
    readonly channel: string;
    readonly agentId: string;
    /** Most recent user message text. */
    readonly userText: string;
    /** Most recent assistant reply text. */
    readonly agentReply: string;
    /** Optional turn correlation id for audit (e.g. thread+ms). */
    readonly sourceTurnId?: string;
}

/**
 * Best-effort extractor for one turn pair. Failures log at WARN and return 0;
 * caller MUST swallow. Quota: `maxPerDay` (default 3) per peer rolling 24h.
 */
export class CommitmentsExtractor {
    constructor(private readonly config: CommitmentsExtractorConfig) {}

    async extract(ctx: ExtractionContext): Promise<number> {
        // INFO lifecycle (one `op:commitment:*` per exit path) so the hidden pass is observable.
        log.info(
            { peerId: ctx.peerId, op: 'commitment:extract-start', userTextLen: ctx.userText.length },
            'commitment extractor invoked',
        );

        // Cheap pre-filter — skip the LLM call for trivially-short user turns.
        if (ctx.userText.trim().length < MIN_CHARS_TO_EXTRACT) {
            log.info(
                { peerId: ctx.peerId, userTextLen: ctx.userText.length, op: 'commitment:skip-short' },
                'commitment extractor: user text too short, skipping',
            );
            return 0;
        }

        // Quota check before the LLM call (24h rolling window).
        const maxPerDay = this.config.maxPerDay ?? DEFAULT_MAX_PER_DAY;
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const recentCount = this.config.store.countCommitmentsCreatedSince(ctx.peerId, dayAgo);
        if (recentCount >= maxPerDay) {
            log.info(
                { peerId: ctx.peerId, recentCount, maxPerDay, op: 'commitment:skip-quota' },
                'commitment extractor: quota exceeded, skipping',
            );
            return 0;
        }

        const minConfidence = this.config.minConfidence ?? MIN_CONFIDENCE;
        const now = Date.now();
        const nowIsoLocal = new Date(now).toISOString();
        const horizonDays = 14;

        const system = buildExtractorSystem(nowIsoLocal, horizonDays);
        const exchange = [
            `User: ${ctx.userText.slice(0, 4000)}`,
            `Assistant: ${ctx.agentReply.slice(0, 4000)}`,
        ].join('\n\n');

        // Retry-with-backoff for transient errors; hard errors propagate. Background-only.
        let raw: string | null = null;
        let lastErr: unknown = null;
        const totalAttempts = RETRY_BACKOFFS_MS.length + 1;
        for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
            try {
                const signal = AbortSignal.timeout(TIMEOUT_MS);
                const response = await this.config.model.invoke(
                    [
                        { role: 'system' as const, content: system },
                        { role: 'user' as const, content: exchange },
                    ],
                    { signal },
                );
                raw = extractText(response.content);
                break;
            } catch (err) {
                lastErr = err;
                const msg = err instanceof Error ? err.message : String(err);
                const transient =
                    /timeout|aborted|ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed|NetworkError|\b50[234]\b|\b429\b/i.test(msg);
                if (!transient || attempt === totalAttempts - 1) {
                    // Either a hard error (no point retrying) OR we're out
                    // of attempts. Bail.
                    break;
                }
                const backoff = RETRY_BACKOFFS_MS[attempt] ?? 1000;
                log.debug(
                    { peerId: ctx.peerId, attempt: attempt + 1, backoffMs: backoff, err: msg },
                    'commitment extractor: transient error, retrying',
                );
                await new Promise<void>((resolve) => setTimeout(resolve, backoff));
            }
        }
        if (raw === null) {
            log.warn(
                {
                    peerId: ctx.peerId,
                    attempts: totalAttempts,
                    err: lastErr instanceof Error ? lastErr.message : String(lastErr),
                },
                'commitment extractor LLM call failed (all retries exhausted)',
            );
            return 0;
        }

        const candidates = parseAndValidate(raw);
        if (!candidates) {
            log.warn(
                { peerId: ctx.peerId, sample: raw.slice(0, 200) },
                'commitment extractor produced invalid JSON',
            );
            return 0;
        }

        if (candidates.length === 0) {
            // Include raw + user/reply heads so operators can distinguish
            // literal `{commitments:[]}` from malformed output and spot mis-extractions.
            log.info(
                {
                    peerId: ctx.peerId,
                    op: 'commitment:none',
                    rawPreview: raw.slice(0, 300),
                    userTextHead: ctx.userText.slice(0, 200),
                    replyHead: ctx.agentReply.slice(0, 200),
                },
                'commitment extractor: model returned no qualifying commitments',
            );
            return 0;
        }

        // Server-side validation; small models have two reliable failure modes:
        //   1. Wrong year (training-cutoff year instead of current) — fix by adding 1y.
        //   2. Just-below-floor (model means "later today") — snap to cutoffMin.
        // Year-fix runs first, then snap.
        const cutoffMin = now + MIN_DUE_HORIZON_MS;
        const cutoffMax = now + MAX_DUE_HORIZON_MS;
        const snapWindow = cutoffMin - SNAP_FLOOR_GRACE_MS;
        const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
        const validated = candidates
            .map((c) => {
                let due = c.due_at_ms;
                // Year-fix
                if (due < now) {
                    const yearLater = due + ONE_YEAR_MS;
                    if (yearLater >= cutoffMin && yearLater <= cutoffMax) {
                        log.info(
                            {
                                originalIso: new Date(due).toISOString(),
                                correctedIso: new Date(yearLater).toISOString(),
                                op: 'commitment:year-corrected',
                            },
                            'commitment: model emitted past year; auto-corrected to next year',
                        );
                        due = yearLater;
                    }
                }
                // Snap-up
                if (due < cutoffMin && due >= snapWindow) {
                    log.debug(
                        { original: due, snappedTo: cutoffMin },
                        'commitment: snapped due_at up to floor',
                    );
                    due = cutoffMin;
                }
                return { ...c, due_at_ms: due };
            })
            .filter((c) => {
                if (c.confidence < minConfidence) return false;
                if (c.due_at_ms < cutoffMin) return false;
                if (c.due_at_ms > cutoffMax) return false;
                return true;
            });

        if (validated.length === 0) {
            log.info(
                {
                    peerId: ctx.peerId,
                    candidates: candidates.length,
                    minConfidence,
                    op: 'commitment:all-filtered',
                    nowIso: new Date(now).toISOString(),
                    drops: candidates.map((c) => ({
                        conf: c.confidence,
                        belowConfidence: c.confidence < minConfidence,
                        tooSoon: c.due_at_ms < cutoffMin,
                        tooFar: c.due_at_ms > cutoffMax,
                        dueAtMs: c.due_at_ms,
                        dueAtIso: new Date(c.due_at_ms).toISOString(),
                        deltaMinFromNow: Math.round((c.due_at_ms - now) / 60_000),
                        followUp: c.follow_up.slice(0, 100),
                    })),
                },
                'commitment extractor: all candidates filtered out',
            );
            return 0;
        }

        // Respect quota at insert time (concurrent extracts could otherwise overshoot).
        const remainingQuota = Math.max(0, maxPerDay - recentCount);
        const toInsert = validated.slice(0, remainingQuota);

        let inserted = 0;
        for (const c of toInsert) {
            try {
                const id = this.config.store.recordCommitment({
                    peerId: ctx.peerId,
                    scope: ctx.scope,
                    channel: ctx.channel,
                    agentId: ctx.agentId,
                    followUp: c.follow_up,
                    dueAtMs: c.due_at_ms,
                    confidence: c.confidence,
                    sourceTurnId: ctx.sourceTurnId ?? null,
                });
                inserted += 1;
                log.info(
                    {
                        peerId: ctx.peerId,
                        commitmentId: id,
                        followUp: c.follow_up,
                        dueAtMs: c.due_at_ms,
                        dueAtIso: new Date(c.due_at_ms).toISOString(),
                        confidence: c.confidence,
                        op: 'commitment:created',
                    },
                    'commitment recorded',
                );
                // Best-effort hook emit; observers never block writes.
                try {
                    emitHook('commitment.created', {
                        commitmentId: id,
                        peerId: ctx.peerId,
                        channel: ctx.channel,
                        agentId: ctx.agentId,
                        followUp: c.follow_up,
                        dueAtMs: c.due_at_ms,
                        confidence: c.confidence,
                    });
                } catch {
                    /* observer pattern — never break the writer */
                }
            } catch (err) {
                log.warn(
                    {
                        peerId: ctx.peerId,
                        err: err instanceof Error ? err.message : String(err),
                    },
                    'commitment insert failed',
                );
            }
        }

        return inserted;
    }
}

function parseAndValidate(raw: string): CommitmentCandidate[] | null {
    const trimmed = raw.trim();
    // Strip markdown fences if the model wrapped output despite instructions.
    const stripped = trimmed
        .replace(/^```(?:json)?\s*/, '')
        .replace(/```\s*$/, '')
        .trim();
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripped);
    } catch {
        return null;
    }
    const result = ExtractorOutput.safeParse(parsed);
    if (!result.success) return null;
    return result.data.commitments;
}

function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((c) => {
                if (typeof c === 'string') return c;
                if (c && typeof c === 'object' && 'text' in c && typeof (c as { text: unknown }).text === 'string') {
                    return (c as { text: string }).text;
                }
                return '';
            })
            .join('');
    }
    return '';
}
