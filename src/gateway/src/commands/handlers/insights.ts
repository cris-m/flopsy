import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandDef } from '../types';
import { getInsightsFacade } from '../insights-facade';
import type {
    InsightsActivity,
    InsightsLongestSession,
    InsightsRecentSession,
    InsightsSnapshot,
    InsightsTokenRow,
} from '../insights-facade';
import { panel, row, STATE, resolveWorkspacePath, workspace } from '@flopsy/shared';

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;

export const insightsCommand: CommandDef = {
    name: 'insights',
    aliases: ['stats', 'usage'],
    description:
        'Usage analytics for this peer over a window. `/insights`, `/insights 7`, `/insights 90`.',
    handler: async (ctx: CommandContext): Promise<{ text: string } | null> => {
        const facade = getInsightsFacade();
        if (!facade) {
            return {
                text: panel(
                    [{ title: '', lines: [row('insights', `${STATE.warn}  not wired (no LearningStore)`, 12)] }],
                ),
            };
        }

        const windowDays = parseWindow(ctx.rawArgs);
        if (windowDays === null) {
            return {
                text: panel(
                    [
                        {
                            title: 'usage',
                            lines: [
                                row('default', '/insights → last 30 days', 12),
                                row('window', '/insights <days> (1–365)', 12),
                                row('example', '/insights 7', 12),
                            ],
                        },
                    ],
                    { header: 'INSIGHTS' },
                ),
            };
        }

        const snapshot = facade.snapshot(ctx.threadId, windowDays);
        if (!snapshot) {
            return {
                text: panel(
                    [
                        {
                            title: 'insights',
                            lines: [
                                row('window', `last ${windowDays} day${windowDays === 1 ? '' : 's'}`, 12),
                                row('status', `${STATE.off}  no activity yet — start a conversation`, 12),
                            ],
                        },
                    ],
                    { header: 'INSIGHTS' },
                ),
            };
        }

        return { text: render(snapshot) };
    },
};

function parseWindow(rawArgs: string): number | null {
    const arg = rawArgs.trim();
    if (arg === '' || arg === 'today') return DEFAULT_WINDOW_DAYS;
    const n = Number.parseInt(arg, 10);
    if (!Number.isFinite(n) || n < 1 || n > MAX_WINDOW_DAYS) return null;
    return n;
}

function render(s: InsightsSnapshot): string {
    const sections = [
        renderActivity(s.windowDays, s.activity),
        renderProactive(),                        // NEW — surfaces dormancy at a glance
        renderTokens(s.tokens),
        renderLongest(s.longestSessions),
        renderRecent(s.recentSessions),
    ].filter((sec) => sec !== null) as Array<{ title: string; lines: string[] }>;

    return panel(sections, { header: 'INSIGHTS' });
}

/**
 * Proactive activity dashboard — makes dormancy IMPOSSIBLE TO MISS.
 *
 * For each heartbeat / cron job, shows runs / delivered / suppressed +
 * timestamp of the last fire. Highlights jobs with 0 deliveries despite
 * runs > 0 (DORMANT). Also surfaces the last lesson/memory write times so
 * silent failure of the learning loop becomes a visible status row.
 *
 * Data sources (no DB dependency — read directly):
 *   - .flopsy/state/proactive.json   (jobs.* + recentDeliveries[] + recentSuppressions[])
 *   - .flopsy/state/memory/USER.md   (mtime → last memory write)
 *   - .flopsy/state/memory/MEMORY.md (mtime)
 *   - .flopsy/content/skills/<cat>/<name>/SKILL.md (mtime of newest → last skill write)
 */
function renderProactive(): { title: string; lines: string[] } | null {
    let stateJson: {
        jobs?: Record<string, {
            runCount?: number;
            deliveredCount?: number;
            suppressedCount?: number;
            lastAction?: string;
            lastRunAt?: number;
            lastStatus?: string;
        }>;
    };
    try {
        const p = resolveWorkspacePath('state', 'proactive.json');
        if (!existsSync(p)) return null;
        stateJson = JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
        return null;
    }
    const jobs = stateJson.jobs ?? {};
    const jobNames = Object.keys(jobs).filter((n) => !n.startsWith('runtime-cron-') && !n.startsWith('test-'));
    if (jobNames.length === 0) return null;

    // Sort by activity (highest runCount first), built-in jobs prioritized.
    const PRIORITY = ['morning-briefing', 'evening-recap', 'weekly-review', 'smart-pulse', 'self-improve', 'dreaming'];
    jobNames.sort((a, b) => {
        const pa = PRIORITY.indexOf(a), pb = PRIORITY.indexOf(b);
        if (pa !== -1 && pb !== -1) return pa - pb;
        if (pa !== -1) return -1;
        if (pb !== -1) return 1;
        return (jobs[b]?.runCount ?? 0) - (jobs[a]?.runCount ?? 0);
    });

    const lines: string[] = [];
    let dormantCount = 0;

    for (const name of jobNames) {
        const j = jobs[name]!;
        const runs = j.runCount ?? 0;
        const delivered = j.deliveredCount ?? 0;
        const suppressed = j.suppressedCount ?? 0;
        const lastAt = j.lastRunAt ?? 0;
        const lastAction = j.lastAction ?? 'never';

        const dormant = runs > 0 && delivered === 0;
        if (dormant) dormantCount++;

        const symbol = dormant ? STATE.fail : delivered > 0 ? STATE.ok : STATE.warn;
        const ratio = runs > 0 ? `${delivered}/${runs}` : '—';
        const pct = runs > 0 ? ` (${Math.round((delivered / runs) * 100)}%)` : '';
        const tag = dormant ? ' DORMANT' : '';
        const when = lastAt > 0 ? fmtRel(lastAt) : 'never';
        lines.push(row(name, `${symbol} ${ratio}${pct}${tag}  ${lastAction} · ${when}`, 20));
    }

    // Learning-loop write activity — surfaces "is anything actually changing?"
    try {
        const userMd = resolveWorkspacePath('state', 'memory', 'USER.md');
        const memMd  = resolveWorkspacePath('state', 'memory', 'MEMORY.md');
        const userM  = existsSync(userMd) ? statSync(userMd).mtimeMs : 0;
        const memM   = existsSync(memMd) ? statSync(memMd).mtimeMs : 0;
        lines.push(row('—', '', 20));
        lines.push(row('USER.md write',   userM > 0 ? fmtRel(userM) : 'never',  20));
        lines.push(row('MEMORY.md write', memM  > 0 ? fmtRel(memM)  : 'never',  20));

        // Newest SKILL.md write across all categories
        const skillsRoot = workspace.skills();
        let newestSkill = { path: '', mtime: 0 };
        if (existsSync(skillsRoot)) {
            for (const cat of readdirSync(skillsRoot, { withFileTypes: true })) {
                if (!cat.isDirectory()) continue;
                const catDir = join(skillsRoot, cat.name);
                for (const sk of readdirSync(catDir, { withFileTypes: true })) {
                    if (!sk.isDirectory()) continue;
                    const sf = join(catDir, sk.name, 'SKILL.md');
                    if (!existsSync(sf)) continue;
                    const m = statSync(sf).mtimeMs;
                    if (m > newestSkill.mtime) newestSkill = { path: `${cat.name}/${sk.name}`, mtime: m };
                }
            }
        }
        lines.push(row(
            'last skill write',
            newestSkill.mtime > 0 ? `${newestSkill.path} · ${fmtRel(newestSkill.mtime)}` : 'never',
            20,
        ));
    } catch {
        // best-effort; missing files just skip
    }

    if (dormantCount > 0) {
        lines.push(row('—', '', 20));
        lines.push(row(
            'ALERT',
            `${STATE.fail}  ${dormantCount} job${dormantCount === 1 ? '' : 's'} dormant (runs > 0, deliveries = 0). Check model/chain.`,
            20,
        ));
    }

    return { title: 'proactive', lines };
}

function renderActivity(
    windowDays: number,
    a: InsightsActivity,
): { title: string; lines: string[] } {
    return {
        title: `activity · last ${windowDays}d`,
        lines: [
            row('sessions', String(a.sessions), 16),
            row('turns', String(a.turns), 16),
            row('messages', `${a.messagesTotal}  (you: ${a.messagesUser} · me: ${a.messagesAssistant})`, 16),
        ],
    };
}

function renderTokens(
    tokens: ReadonlyArray<InsightsTokenRow>,
): { title: string; lines: string[] } | null {
    if (tokens.length === 0) return null;
    const totalIn = tokens.reduce((acc, t) => acc + t.input, 0);
    const totalOut = tokens.reduce((acc, t) => acc + t.output, 0);
    const totalCalls = tokens.reduce((acc, t) => acc + t.calls, 0);

    const lines = [
        row('total', `${fmt(totalIn + totalOut)} tok  (${fmt(totalCalls)} calls)`, 16),
        row('in / out', `${fmt(totalIn)} / ${fmt(totalOut)}`, 16),
        row('— by model —', '', 16),
    ];
    const top = tokens.slice(0, 6);
    const rest = tokens.slice(6);
    for (const t of top) {
        const totalT = t.input + t.output;
        lines.push(row(`${t.provider}/${t.model}`, `${fmt(totalT)} tok  (${fmt(t.calls)} calls)`, 16));
    }
    if (rest.length > 0) {
        const otherTok = rest.reduce((acc, t) => acc + t.input + t.output, 0);
        const otherCalls = rest.reduce((acc, t) => acc + t.calls, 0);
        lines.push(row(`+${rest.length} others`, `${fmt(otherTok)} tok  (${fmt(otherCalls)} calls)`, 16));
    }
    return { title: 'token spend', lines };
}

function renderLongest(
    longest: ReadonlyArray<InsightsLongestSession>,
): { title: string; lines: string[] } | null {
    if (longest.length === 0) return null;
    const lines = longest.map((s) => {
        const turns = `${s.turnCount} turn${s.turnCount === 1 ? '' : 's'}`;
        const when = fmtRel(s.openedAt);
        const summary = s.summary ? ` · ${truncate(s.summary, 50)}` : '';
        return row(turns, `${when}${summary}`, 12);
    });
    return { title: 'longest sessions', lines };
}

function renderRecent(
    recent: ReadonlyArray<InsightsRecentSession>,
): { title: string; lines: string[] } | null {
    if (recent.length === 0) return null;
    const lines = recent.map((s) =>
        row(fmtRel(s.closedAt), truncate(s.summary, 70), 12),
    );
    return { title: 'recent sessions', lines };
}

function fmt(n: number): string {
    if (n < 1_000) return String(n);
    if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

function fmtRel(ts: number): string {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60_000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}
