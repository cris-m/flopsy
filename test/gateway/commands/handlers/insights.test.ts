/**
 * /insights slash command — usage analytics for the current peer.
 *
 * Tests window parsing, no-activity / no-facade fallbacks, and the rendered
 * panel for each section (activity, tokens, longest, recent).
 *
 * The InsightsFacade is stubbed to return canned snapshots so we exercise
 * just the renderer + parser.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { insightsCommand } from '@flopsy/gateway/commands/handlers/insights';
import type { CommandContext } from '@flopsy/gateway/commands/types';
import {
    setInsightsFacade,
    type InsightsFacade,
    type InsightsSnapshot,
} from '@flopsy/gateway/commands/insights-facade';

function ctx(rawArgs: string): CommandContext {
    return {
        args: rawArgs.split(/\s+/).filter(Boolean),
        rawArgs,
        channelName: 'telegram',
        peer: { id: '1', type: 'user', name: 'tester' },
        threadId: 'telegram:dm:1#s-current',
    };
}

async function run(args: string): Promise<string> {
    const r = await insightsCommand.handler(ctx(args));
    return (r as { text: string }).text;
}

function fakeFacade(snapshot: InsightsSnapshot | null): InsightsFacade {
    return { snapshot: () => snapshot };
}

afterEach(() => {
    setInsightsFacade(null);
});

describe('/insights — wiring', () => {
    it('warns when the facade is not set', async () => {
        const out = await run('');
        expect(out).toMatch(/not wired/i);
    });
});

describe('/insights — window parsing', () => {
    it('default of 30 days when no arg', async () => {
        let captured = -1;
        setInsightsFacade({
            snapshot: (_key, w) => {
                captured = w;
                return null;
            },
        });
        await run('');
        expect(captured).toBe(30);
    });

    it('accepts integer days', async () => {
        let captured = -1;
        setInsightsFacade({
            snapshot: (_key, w) => {
                captured = w;
                return null;
            },
        });
        await run('7');
        expect(captured).toBe(7);
    });

    it('renders usage panel for invalid window (non-numeric)', async () => {
        setInsightsFacade(fakeFacade(null));
        const out = await run('forever');
        expect(out).toMatch(/usage/i);
        expect(out).toMatch(/1–365/);
    });

    it('renders usage panel for out-of-range window (>365)', async () => {
        setInsightsFacade(fakeFacade(null));
        const out = await run('1000');
        expect(out).toMatch(/usage/i);
    });

    it('renders usage panel for zero / negative', async () => {
        setInsightsFacade(fakeFacade(null));
        const out = await run('0');
        expect(out).toMatch(/usage/i);
    });
});

describe('/insights — no activity', () => {
    it('renders the "no activity yet" panel when snapshot is null', async () => {
        setInsightsFacade(fakeFacade(null));
        const out = await run('30');
        expect(out).toMatch(/no activity yet/i);
        expect(out).toMatch(/last 30 days/);
    });
});

describe('/insights — render with data', () => {
    function activitySnapshot(): InsightsSnapshot {
        return {
            windowDays: 30,
            sinceMs: Date.now() - 30 * 86_400_000,
            activity: {
                sessions: 12,
                turns: 87,
                messagesTotal: 174,
                messagesUser: 87,
                messagesAssistant: 87,
            },
            tokens: [
                {
                    provider: 'anthropic',
                    model: 'claude-opus-4-7',
                    input: 12000,
                    output: 4000,
                    calls: 7,
                },
                {
                    provider: 'ollama',
                    model: 'gemma4:e4b',
                    input: 800,
                    output: 200,
                    calls: 3,
                },
            ],
            longestSessions: [
                {
                    sessionId: 's-long',
                    turnCount: 30,
                    openedAt: Date.now() - 6 * 86_400_000,
                    closedAt: Date.now() - 5 * 86_400_000,
                    summary: 'debugged the proactive engine end to end',
                },
            ],
            recentSessions: [
                {
                    sessionId: 's-recent',
                    closedAt: Date.now() - 60_000,
                    summary: 'helped wire up the harness interceptor',
                },
            ],
        };
    }

    it('renders activity counts', async () => {
        setInsightsFacade(fakeFacade(activitySnapshot()));
        const out = await run('30');
        expect(out).toMatch(/sessions/);
        expect(out).toContain('12');
        expect(out).toMatch(/turns/);
        expect(out).toContain('87');
    });

    it('renders token totals + per-model breakdown', async () => {
        setInsightsFacade(fakeFacade(activitySnapshot()));
        const out = await run('30');
        expect(out).toMatch(/token spend/i);
        expect(out).toContain('anthropic/claude-opus-4-7');
        expect(out).toContain('ollama/gemma4:e4b');
    });

    it('renders longest sessions section with turn count + summary truncation', async () => {
        setInsightsFacade(fakeFacade(activitySnapshot()));
        const out = await run('30');
        expect(out).toMatch(/longest sessions/i);
        expect(out).toMatch(/30 turns?/);
    });

    it('omits token-spend section when no tokens recorded', async () => {
        const empty = {
            ...activitySnapshot(),
            tokens: [],
        };
        setInsightsFacade(fakeFacade(empty));
        const out = await run('30');
        expect(out).not.toMatch(/token spend/i);
    });

    it('omits longest-sessions when none recorded', async () => {
        const empty = {
            ...activitySnapshot(),
            longestSessions: [],
        };
        setInsightsFacade(fakeFacade(empty));
        const out = await run('30');
        expect(out).not.toMatch(/longest sessions/i);
    });
});
