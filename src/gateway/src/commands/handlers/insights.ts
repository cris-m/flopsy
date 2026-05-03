import type { CommandContext, CommandDef } from '../types';
import { getInsightsFacade } from '../insights-facade';
import type {
    InsightsActivity,
    InsightsLongestSession,
    InsightsRecentSession,
    InsightsSnapshot,
    InsightsTokenRow,
} from '../insights-facade';
import { panel, row, STATE } from '@flopsy/shared';

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
        renderTokens(s.tokens),
        renderLongest(s.longestSessions),
        renderRecent(s.recentSessions),
    ].filter((sec) => sec !== null) as Array<{ title: string; lines: string[] }>;

    return panel(sections, { header: 'INSIGHTS' });
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
