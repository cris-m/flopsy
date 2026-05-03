/** Read-only late-bound bridge between /insights and LearningStore. */

export interface InsightsActivity {
    readonly sessions: number;
    readonly turns: number;
    readonly messagesTotal: number;
    readonly messagesUser: number;
    readonly messagesAssistant: number;
}

export interface InsightsTokenRow {
    readonly provider: string;
    readonly model: string;
    readonly input: number;
    readonly output: number;
    readonly calls: number;
}

export interface InsightsLongestSession {
    readonly sessionId: string;
    readonly turnCount: number;
    readonly openedAt: number;
    readonly closedAt: number | null;
    readonly summary: string | null;
}

export interface InsightsRecentSession {
    readonly sessionId: string;
    readonly closedAt: number;
    readonly summary: string;
}

export interface InsightsSnapshot {
    readonly windowDays: number;
    readonly sinceMs: number;
    readonly activity: InsightsActivity;
    readonly tokens: ReadonlyArray<InsightsTokenRow>;
    readonly longestSessions: ReadonlyArray<InsightsLongestSession>;
    readonly recentSessions: ReadonlyArray<InsightsRecentSession>;
}

export interface InsightsFacade {
    /** Returns null on a brand-new install with no peer/session yet. */
    snapshot(rawKey: string, windowDays: number): InsightsSnapshot | null;
}

let facade: InsightsFacade | null = null;

export function setInsightsFacade(f: InsightsFacade | null): void {
    facade = f;
}

export function getInsightsFacade(): InsightsFacade | null {
    return facade;
}
