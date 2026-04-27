import type { StateStore } from '../state/store';
import type { ProactiveDedupStore } from '../state/dedup-store';

const DELIVERED_TOPIC_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const SUPPRESSED_TOPIC_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MAX_TOPICS_IN_PROMPT = 20;
const MAX_REPORTED_IDS_PER_TYPE = 10;

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

/**
 * Build a markdown context block listing what the agent has already covered
 * recently — by semantic topic and by stable item ID. Prepended to the prompt
 * so the agent naturally avoids repeating itself even when rephrasing would
 * produce a different content hash.
 *
 * Topics carry cooldown windows (3d if delivered, 12h if suppressed).
 * Returns an empty string when there's nothing to inject.
 */
export function buildAntiRepetitionContext(
    store: StateStore,
    dedupStore: ProactiveDedupStore,
): string {
    const now = Date.now();
    const lines: string[] = [];

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
        lines.push('**Recent topics (DO NOT repeat these — pick a new angle or suppress):**');
        for (const [topic, coveredAt] of activeTopics) {
            lines.push(`  - "${topic}" (${formatAgo(now - coveredAt)})`);
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

    if (lines.length === 0) return '';
    return '<anti_repetition>\n' + lines.join('\n') + '\n</anti_repetition>\n\n';
}

/**
 * Parse `REPORTED: emails=[id1,id2] news=[url1]` lines from raw agent output.
 * Auto-extracts http(s) URLs for news-style jobs as a fallback.
 */
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

/**
 * Strip REPORTED: tracking lines from text before delivery.
 */
export function stripReportedLines(text: string): string {
    return text
        .split('\n')
        .filter((line) => !/^\s*REPORTED:\s*/i.test(line))
        .join('\n')
        .trim();
}
