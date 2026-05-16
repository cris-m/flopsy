/**
 * Self-review block builder for the `self-improve` heartbeat.
 *
 * Reads the recent `proactive_decisions` rows for a peer and emits an
 * `<proactive_self_review>` block summarising anti-patterns. The block is
 * prepended to the heartbeat prompt by the trigger before the agent runs —
 * so the agent never has to query the DB. Empty sections are omitted; if
 * no pattern is detected, the whole block is empty (and the heartbeat
 * prompt instructs the agent to bail).
 *
 * Anti-patterns covered:
 *   1. Narration suspects — short `delivered=1, has_structured=0` messages
 *      whose preview reads like a status line ("delivered", "done",
 *      "still running"). This is the exact bug the proactive skill's
 *      "When YOU Are the Fire" rule is meant to prevent.
 *   2. Low-response delivered fires — jobs that deliver but the user
 *      never replies. Signal to lower the cadence or tighten relevance.
 *   3. Recurring silences — same (job, silence_reason) pair tripping 3+
 *      times in window. Either the suppression is correct (then it's
 *      not really an anti-pattern, just signal for the operator) or the
 *      fetch path is broken (then the reason should be widened).
 */
import { createLogger } from '@flopsy/shared';
import { getSharedLearningStore, type ProactiveDecisionRow } from '@flopsy/team';

const log = createLogger('proactive-self-review');

const NARRATION_PREVIEW_MAX_LEN = 300;
const NARRATION_KEYWORDS = [
    'delivered',
    'done.',
    'sent.',
    'still running',
    'will arrive',
    'workers',
    'i\'ve composed',
    'have been sent',
];
const LOW_RESPONSE_MIN_DELIVERED = 4;
const LOW_RESPONSE_RATIO_THRESHOLD = 0.2;
const RECURRING_SILENCE_MIN_COUNT = 3;
const MAX_ROW_FETCH = 200;
const MAX_NARRATION_LINES = 5;
const MAX_BLOCK_BYTES = 2_048;

interface NarrationSuspect {
    job: string;
    firedAt: number;
    messageLen: number;
    preview: string;
}

interface LowResponseRow {
    job: string;
    delivered: number;
    responded: number;
}

interface RecurringSilenceRow {
    job: string;
    reason: string;
    count: number;
}

/**
 * Build the `<proactive_self_review>` block. Returns an empty string when
 * no anti-pattern hits — heartbeat prompt then bails with a single `OK`.
 */
export function buildProactiveSelfReviewBlock(peerId: string, windowMs: number): string {
    let rows: ProactiveDecisionRow[];
    try {
        rows = getSharedLearningStore().getRecentProactiveDecisions(
            peerId,
            windowMs,
            MAX_ROW_FETCH,
        );
    } catch (err) {
        log.warn(
            { err: err instanceof Error ? err.message : String(err), peerId },
            'self-review: getRecentProactiveDecisions failed; returning empty block',
        );
        return '';
    }

    if (rows.length === 0) return '';

    const narrationSuspects = detectNarrationSuspects(rows);
    const lowResponse = detectLowResponse(rows);
    const recurringSilences = detectRecurringSilences(rows);

    if (
        narrationSuspects.length === 0 &&
        lowResponse.length === 0 &&
        recurringSilences.length === 0
    ) {
        return '';
    }

    const total = rows.length;
    const delivered = rows.filter((r) => r.delivered === 1).length;
    const suppressed = rows.filter((r) => r.delivered === 0).length;
    const errored = rows.filter((r) => r.delivered === 2).length;

    const lines: string[] = [];
    lines.push(`<proactive_self_review window="${formatWindow(windowMs)}">`);
    lines.push(
        `  fires: ${total} total (${delivered} delivered, ${suppressed} suppressed, ${errored} error)`,
    );

    if (narrationSuspects.length > 0) {
        lines.push('  narration_suspects:');
        for (const s of narrationSuspects.slice(0, MAX_NARRATION_LINES)) {
            lines.push(
                `    - ${s.job} @${isoMinute(s.firedAt)}: ${s.messageLen}ch "${truncate(s.preview, 120)}"`,
            );
        }
    }

    if (lowResponse.length > 0) {
        lines.push('  low_response:');
        for (const r of lowResponse) {
            lines.push(`    - ${r.job}: ${r.responded}/${r.delivered} user replies`);
        }
    }

    if (recurringSilences.length > 0) {
        lines.push('  recurring_silence:');
        for (const r of recurringSilences) {
            lines.push(`    - ${r.job}: ${r.reason} × ${r.count}`);
        }
    }

    lines.push('</proactive_self_review>');

    const out = lines.join('\n');
    return out.length > MAX_BLOCK_BYTES ? out.slice(0, MAX_BLOCK_BYTES) : out;
}

function detectNarrationSuspects(rows: ProactiveDecisionRow[]): NarrationSuspect[] {
    const out: NarrationSuspect[] = [];
    for (const r of rows) {
        if (r.delivered !== 1) continue;
        if (r.hasStructured === 1) continue; // structured fires never narrate by contract
        if (r.messageLen >= NARRATION_PREVIEW_MAX_LEN) continue;
        const preview = (r.messagePreview ?? '').toLowerCase();
        if (!NARRATION_KEYWORDS.some((kw) => preview.includes(kw))) continue;
        out.push({
            job: r.jobName ?? r.jobId,
            firedAt: r.firedAt,
            messageLen: r.messageLen,
            preview: r.messagePreview ?? '',
        });
    }
    return out;
}

function detectLowResponse(rows: ProactiveDecisionRow[]): LowResponseRow[] {
    const byJob = new Map<string, { delivered: number; responded: number }>();
    for (const r of rows) {
        if (r.delivered !== 1) continue;
        const key = r.jobName ?? r.jobId;
        const cur = byJob.get(key) ?? { delivered: 0, responded: 0 };
        cur.delivered += 1;
        if (r.userResponded === 1) cur.responded += 1;
        byJob.set(key, cur);
    }
    const out: LowResponseRow[] = [];
    for (const [job, { delivered, responded }] of byJob) {
        if (delivered < LOW_RESPONSE_MIN_DELIVERED) continue;
        if (responded / delivered >= LOW_RESPONSE_RATIO_THRESHOLD) continue;
        out.push({ job, delivered, responded });
    }
    return out;
}

function detectRecurringSilences(rows: ProactiveDecisionRow[]): RecurringSilenceRow[] {
    const byPair = new Map<string, { job: string; reason: string; count: number }>();
    for (const r of rows) {
        if (r.delivered !== 0) continue;
        if (!r.silenceReason) continue;
        const job = r.jobName ?? r.jobId;
        const key = `${job}|${r.silenceReason}`;
        const cur = byPair.get(key) ?? { job, reason: r.silenceReason, count: 0 };
        cur.count += 1;
        byPair.set(key, cur);
    }
    const out: RecurringSilenceRow[] = [];
    for (const v of byPair.values()) {
        if (v.count >= RECURRING_SILENCE_MIN_COUNT) out.push(v);
    }
    return out;
}

function formatWindow(ms: number): string {
    const h = Math.round(ms / 3_600_000);
    if (h < 24) return `${h}h`;
    const d = Math.round(ms / 86_400_000);
    return `${d}d`;
}

function isoMinute(ms: number): string {
    return new Date(ms).toISOString().slice(11, 16); // HH:MM UTC
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s.replace(/\s+/g, ' ');
    return s.slice(0, max - 1).replace(/\s+/g, ' ') + '…';
}
