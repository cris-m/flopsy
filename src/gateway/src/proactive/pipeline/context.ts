import type { StateStore } from '../state/store';
import type { ProactiveDedupStore } from '../state/dedup-store';
import { getSharedLearningStore } from '@flopsy/team';

const DELIVERED_TOPIC_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const SUPPRESSED_TOPIC_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MAX_TOPICS_IN_PROMPT = 20;
const MAX_REPORTED_IDS_PER_TYPE = 10;
const MAX_DELIVERIES_IN_PROMPT = 6;

function formatAgo(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    if (m > 0) return `${m}m ago`;
    return 'just now';
}

/** Local midnight in epoch ms — uses the running process timezone. */
function midnightMsToday(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** Trim a delivery preview to a single-line snippet for the prompt. */
function previewLine(content: string, max = 140): string {
    const oneLine = content.replace(/\s+/g, ' ').trim();
    return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

/**
 * Anti-repetition block: delivery snippets, suppressed candidates, recent topics,
 * reported IDs, and per-mode last-fired. Deliberately omits delivery counts to
 * avoid self-rationing behaviour.
 */
export function buildAntiRepetitionContext(
    store: StateStore,
    dedupStore: ProactiveDedupStore,
    opts: { jobId?: string } = {},
): string {
    const now = Date.now();
    const lines: string[] = [];

    const midnight = midnightMsToday();
    const deliveries = store.getRecentDeliveries();
    const todayDeliveries = deliveries.filter((d) => d.deliveredAt >= midnight);

    if (todayDeliveries.length > 0) {
        lines.push('**Recent delivery snippets (DO NOT repeat the same surface — pick a fresh angle or skip if there is no fresh angle):**');
        const recent = todayDeliveries.slice(0, MAX_DELIVERIES_IN_PROMPT);
        for (const d of recent) {
            const ago = formatAgo(now - d.deliveredAt);
            lines.push(`  - [${d.source}, ${ago}] ${previewLine(d.content)}`);
        }
    }

    // Suppressed candidates from the last 6h — fresh enough to be relevant.
    const recentSuppressions = store.getRecentSuppressions()
        .filter((s) => now - s.suppressedAt < 6 * 60 * 60 * 1000)
        .slice(0, MAX_DELIVERIES_IN_PROMPT);
    if (recentSuppressions.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('**Recently suppressed candidates (already considered & rejected — do NOT re-propose the same angle):**');
        for (const s of recentSuppressions) {
            const ago = formatAgo(now - s.suppressedAt);
            const tag = s.mode ? `${s.source}/${s.mode}` : s.source;
            const why = s.reason ? ` — ${previewLine(s.reason, 80)}` : '';
            lines.push(`  - [${tag}, ${ago}]${why}`);
            lines.push(`      ${previewLine(s.content)}`);
        }
    }

    const topicMap = new Map<string, number>();
    for (const t of store.getRecentTopics()) {
        const window = t.delivered === false ? SUPPRESSED_TOPIC_COOLDOWN_MS : DELIVERED_TOPIC_COOLDOWN_MS;
        if (now - t.coveredAt >= window) continue;
        const key = t.topic.toLowerCase().trim();
        const existing = topicMap.get(key);
        if (!existing || t.coveredAt > existing) {
            topicMap.set(key, t.coveredAt);
        }
    }
    const activeTopics = Array.from(topicMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_TOPICS_IN_PROMPT);

    if (activeTopics.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('**Recent topics (DO NOT repeat these — pick a new angle or suppress):**');
        for (const [topic, coveredAt] of activeTopics) {
            lines.push(`  - "${topic}" (${formatAgo(now - coveredAt)})`);
        }
    }

    // Per-mode last-fired (smart-pulse cooldowns, no tool access needed).
    if (opts.jobId) {
        const lastByMode = dedupStore.getLastFiredByMode(opts.jobId);
        const entries = Object.entries(lastByMode);
        if (entries.length > 0) {
            if (lines.length > 0) lines.push('');
            lines.push('**Per-mode last-fired (use these for cooldown checks):**');
            entries.sort((a, b) => b[1] - a[1]);
            for (const [mode, lastAt] of entries) {
                lines.push(`  - ${mode}: ${formatAgo(now - lastAt)}`);
            }
        }
    }

    const parts: string[] = [];
    const emails = dedupStore.listReported('emails', MAX_REPORTED_IDS_PER_TYPE);
    const meetings = dedupStore.listReported('meetings', MAX_REPORTED_IDS_PER_TYPE);
    const tasks = dedupStore.listReported('tasks', MAX_REPORTED_IDS_PER_TYPE);
    const news = dedupStore.listReported('news', MAX_REPORTED_IDS_PER_TYPE);
    if (emails.length) parts.push(`  Emails: ${emails.join(', ')}`);
    if (meetings.length) parts.push(`  Meetings: ${meetings.join(', ')}`);
    if (tasks.length) parts.push(`  Tasks: ${tasks.join(', ')}`);
    if (news.length) parts.push(`  News: ${news.join(', ')}`);
    if (parts.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('**Already reported IDs (skip items whose ID matches):**');
        lines.push(...parts);
    }

    // Skip wrapper when empty — saves the agent tokens parsing a noisy block.
    if (lines.length === 0) return '';
    return '<anti_repetition>\n' + lines.join('\n') + '\n</anti_repetition>\n\n';
}

/**
 * Inject due inferred-commitments for the peer (channel-agnostic).
 * Each entry includes its DB id so the agent can mark delivered via reportedIds.commitments.
 */
export function buildCommitmentsBlock(
    peerId: string | undefined,
    nowMs: number = Date.now(),
): string {
    if (!peerId) return '';
    let rows: ReturnType<ReturnType<typeof getSharedLearningStore>['listDueCommitments']>;
    try {
        rows = getSharedLearningStore().listDueCommitments(peerId, nowMs, 5);
    } catch {
        // Best-effort — never break a fire on missing/unmigrated commitments table.
        return '';
    }
    if (rows.length === 0) return '';

    const lines: string[] = [
        '<commitments_due_now>',
        'These follow-ups were inferred from prior conversations and are due now.',
        'Treat them as DECISION ORDER #1 — lead the message with the most relevant one',
        'using natural phrasing ("you mentioned X yesterday — how did it go?"). When you',
        'deliver, include each surfaced commitment id in `reportedIds.commitments[]` so',
        'the engine marks it delivered.',
        '',
    ];
    for (const r of rows) {
        const dueAgo = Math.max(0, Math.floor((nowMs - r.dueAtMs) / 1000));
        const ago = dueAgo < 60
            ? `${dueAgo}s ago`
            : dueAgo < 3600
                ? `${Math.floor(dueAgo / 60)}m ago`
                : `${Math.floor(dueAgo / 3600)}h ago`;
        lines.push(`  - id=${r.id} (due ${ago}, confidence ${r.confidence.toFixed(2)})`);
        // Strip closing-tag injections from LLM-extracted user content.
        const safe = r.followUp
            .replace(/<\/commitments_due_now>/gi, '[/commitments_due_now_LITERAL]')
            .replace(/<\/active_skills>/gi, '[/active_skills_LITERAL]')
            .replace(/<\/pre_check>/gi, '[/pre_check_LITERAL]')
            .replace(/<\/fire_context>/gi, '[/fire_context_LITERAL]');
        lines.push(`      ${safe}`);
    }
    lines.push('</commitments_due_now>');
    return lines.join('\n') + '\n\n';
}

/** Parse `REPORTED:` lines; auto-extract URLs as news fallback. */
export function parseReportedLines(
    text: string,
    jobName: string,
): { emails: string[]; meetings: string[]; tasks: string[]; news: string[] } {
    const out = {
        emails: [] as string[],
        meetings: [] as string[],
        tasks: [] as string[],
        news: [] as string[],
    };

    for (const line of text.split('\n')) {
        const m = line.match(/^\s*REPORTED:\s*(.+)$/i);
        if (!m?.[1]) continue;
        const payload = m[1];
        const re = /(emails|meetings|tasks|news)\s*=\s*\[([^\]]*)\]/gi;
        let tm: RegExpExecArray | null;
        while ((tm = re.exec(payload)) !== null) {
            const type = tm[1]!.toLowerCase() as keyof typeof out;
            const ids = tm[2]!
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            out[type].push(...ids);
        }
    }

    const lower = jobName.toLowerCase();
    if (lower.includes('news') || lower.includes('briefing') || lower.includes('digest')) {
        const urls = text.match(/https?:\/\/[^\s)>\]"']+/gi);
        if (urls) {
            const clean = [...new Set(urls.map((u) => u.replace(/[.,;:!?]+$/, '')))];
            out.news.push(...clean);
        }
    }

    return out;
}

export function stripReportedLines(text: string): string {
    return text
        .split('\n')
        .filter((line) => !/^\s*REPORTED:\s*/i.test(line))
        .join('\n')
        .trim();
}
