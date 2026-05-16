import { getSharedLearningStore } from '@flopsy/team';

export interface PatternFinding {
    readonly kind: 'low_response_job' | 'preferred_hour' | 'dismissed_category' | 'silent_recurring';
    readonly summary: string;
    readonly support: number;
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_SUPPORT_LOW_RESPONSE = 4;
const LOW_RESPONSE_RATE = 0.2;
const MIN_SUPPORT_PREFERRED_HOUR = 3;
const MIN_SUPPORT_DISMISSED = 3;
const MIN_SUPPORT_SILENCE = 3;

export function detectPatterns(peerId: string | undefined, nowMs: number = Date.now()): PatternFinding[] {
    if (!peerId) return [];
    let db;
    try {
        db = getSharedLearningStore().getDatabase();
    } catch {
        return [];
    }
    const since = nowMs - WINDOW_MS;
    const out: PatternFinding[] = [];

    try {
        const lowResp = db
            .prepare(
                `SELECT job_name, COUNT(*) AS n,
                        SUM(CASE WHEN delivered=1 AND user_responded=1 THEN 1 ELSE 0 END) AS replies,
                        SUM(CASE WHEN delivered=1 THEN 1 ELSE 0 END) AS delivered_count
                   FROM proactive_decisions
                  WHERE peer_id = ? AND fired_at >= ?
                  GROUP BY job_name
                 HAVING delivered_count >= ?`,
            )
            .all(peerId, since, MIN_SUPPORT_LOW_RESPONSE) as Array<{
                job_name: string | null;
                n: number;
                replies: number;
                delivered_count: number;
            }>;
        for (const row of lowResp) {
            const name = row.job_name ?? 'unknown';
            const rate = row.delivered_count > 0 ? row.replies / row.delivered_count : 0;
            if (rate <= LOW_RESPONSE_RATE) {
                out.push({
                    kind: 'low_response_job',
                    support: row.delivered_count,
                    summary: `Job "${name}": ${row.replies}/${row.delivered_count} fires got a user reply in the last 30d (${Math.round(rate * 100)}%). User ignores this cadence — consider backing off or rephrasing.`,
                });
            }
        }
    } catch { /* table missing — fall through */ }

    try {
        const hourRows = db
            .prepare(
                `SELECT CAST(strftime('%H', fired_at/1000, 'unixepoch', 'localtime') AS INTEGER) AS hr,
                        COUNT(*) AS replies
                   FROM proactive_decisions
                  WHERE peer_id = ? AND fired_at >= ? AND user_responded = 1
                  GROUP BY hr
                  ORDER BY replies DESC
                  LIMIT 3`,
            )
            .all(peerId, since) as Array<{ hr: number; replies: number }>;
        const top = hourRows.filter((r) => r.replies >= MIN_SUPPORT_PREFERRED_HOUR);
        if (top.length > 0) {
            const list = top.map((r) => `${String(r.hr).padStart(2, '0')}:00 (${r.replies} replies)`).join(', ');
            out.push({
                kind: 'preferred_hour',
                support: top.reduce((acc, r) => acc + r.replies, 0),
                summary: `User responds most often around: ${list}. Prefer these windows when timing is flexible.`,
            });
        }
    } catch { /* fall through */ }

    try {
        const dismissed = db
            .prepare(
                `SELECT COUNT(*) AS n
                   FROM proactive_commitments
                  WHERE peer_id = ? AND status = 'dismissed'
                    AND coalesce(resolved_at, created_at) >= ?`,
            )
            .get(peerId, since) as { n: number } | undefined;
        if (dismissed && dismissed.n >= MIN_SUPPORT_DISMISSED) {
            out.push({
                kind: 'dismissed_category',
                support: dismissed.n,
                summary: `User has dismissed ${dismissed.n} inferred follow-ups in the last 30d. Be conservative — only surface commitments when conviction is high.`,
            });
        }
    } catch { /* fall through */ }

    try {
        const silentRows = db
            .prepare(
                `SELECT job_name, silence_reason, COUNT(*) AS n
                   FROM proactive_decisions
                  WHERE peer_id = ? AND fired_at >= ? AND delivered = 0
                    AND silence_reason IS NOT NULL
                  GROUP BY job_name, silence_reason
                 HAVING n >= ?
                  ORDER BY n DESC
                  LIMIT 3`,
            )
            .all(peerId, since, MIN_SUPPORT_SILENCE) as Array<{
                job_name: string | null;
                silence_reason: string;
                n: number;
            }>;
        for (const row of silentRows) {
            out.push({
                kind: 'silent_recurring',
                support: row.n,
                summary: `Job "${row.job_name ?? 'unknown'}" suppressed itself ${row.n}× recently (reason: ${row.silence_reason}). Review job config or prompt.`,
            });
        }
    } catch { /* fall through */ }

    return out;
}

export function buildPatternFindingsBlock(peerId: string | undefined, nowMs: number = Date.now()): string {
    const findings = detectPatterns(peerId, nowMs);
    if (findings.length === 0) return '';
    const lines = [
        '<pattern_findings description="Deterministic patterns from your delivery + response history (30d window). Treat as behavioural ground-truth: if a finding flags low engagement, do not double down on the same approach.">',
        ...findings.map((f) => `  - [${f.kind}] ${f.summary}`),
        '</pattern_findings>',
    ];
    return lines.join('\n') + '\n\n';
}
