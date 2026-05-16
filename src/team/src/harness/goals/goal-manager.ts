import { createLogger } from '@flopsy/shared';
import type { BaseChatModel } from 'flopsygraph';
import type { LearningStore, SessionGoalRow, GoalStatus } from '../storage/learning-store';

const log = createLogger('goal-manager');

export const DEFAULT_MAX_TURNS = 20;
const DEFAULT_JUDGE_TIMEOUT_MS = 30_000;
const DEFAULT_JUDGE_MAX_TOKENS = 4096;
const JUDGE_RESPONSE_SNIPPET_CHARS = 4000;
const DEFAULT_MAX_CONSECUTIVE_PARSE_FAILURES = 3;

const JUDGE_SYSTEM_PROMPT = [
    "You are a strict judge evaluating whether an autonomous agent has",
    "achieved a user's stated goal. You receive the goal text and the",
    "agent's most recent response. Your only job is to decide whether",
    "the goal is fully satisfied based on that response.",
    "",
    "A goal is DONE only when:",
    "- The response explicitly confirms the goal was completed, OR",
    "- The response clearly shows the final deliverable was produced, OR",
    "- The response explains the goal is unachievable / blocked / needs",
    "  user input (treat this as DONE with reason describing the block).",
    "",
    "Otherwise the goal is NOT done — CONTINUE.",
    "",
    "Reply ONLY with a single JSON object on one line:",
    '{"done": <true|false>, "reason": "<one-sentence rationale>"}',
].join('\n');

const CONTINUATION_TEMPLATE =
    "[Continuing toward your standing goal]\n" +
    "Goal: {goal}\n\n" +
    "Continue working toward this goal. Take the next concrete step. " +
    "If you believe the goal is complete, state so explicitly and stop. " +
    "If you are blocked and need input from the user, say so clearly and stop.";

export interface GoalJudgeVerdict {
    readonly done: boolean;
    readonly reason: string;
    readonly verdict: 'done' | 'continue' | 'skipped';
}

export interface GoalManagerConfig {
    readonly model: BaseChatModel;
    readonly store: LearningStore;
    readonly maxTurns?: number;
    readonly judgeTimeoutMs?: number;
    readonly maxConsecutiveParseFailures?: number;
}

export interface SetGoalArgs {
    readonly threadId: string;
    readonly channelName: string;
    readonly peerId: string;
    readonly goal: string;
    readonly maxTurns?: number;
}

export interface MaybeContinueArgs {
    readonly threadId: string;
    readonly agentReply: string;
}

export interface MaybeContinueResult {
    readonly shouldContinue: boolean;
    readonly continuationPrompt?: string;
    readonly verdict?: GoalJudgeVerdict;
    readonly newStatus: GoalStatus;
    readonly turnsUsed: number;
    readonly maxTurns: number;
    readonly stopReason?: 'done' | 'budget' | 'paused' | 'cleared' | 'parse_failures';
}

export class GoalManager {
    private readonly maxTurns: number;
    private readonly judgeTimeoutMs: number;
    private readonly maxParseFailures: number;

    constructor(private readonly config: GoalManagerConfig) {
        this.maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
        this.judgeTimeoutMs = config.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
        this.maxParseFailures = config.maxConsecutiveParseFailures ?? DEFAULT_MAX_CONSECUTIVE_PARSE_FAILURES;
    }

    get(threadId: string): SessionGoalRow | null {
        return this.config.store.getSessionGoal(threadId);
    }

    set(args: SetGoalArgs): SessionGoalRow {
        const now = Date.now();
        const row: SessionGoalRow = {
            threadId: args.threadId,
            goal: args.goal.trim(),
            status: 'active',
            turnsUsed: 0,
            maxTurns: args.maxTurns ?? this.maxTurns,
            parseFailures: 0,
            createdAt: now,
            lastTurnAt: now,
            lastVerdict: null,
            lastReason: null,
            channelName: args.channelName,
            peerId: args.peerId,
        };
        this.config.store.upsertSessionGoal(row);
        log.info({ threadId: args.threadId, goal: row.goal, maxTurns: row.maxTurns }, 'goal set');
        return row;
    }

    pause(threadId: string): SessionGoalRow | null {
        const row = this.get(threadId);
        if (!row) return null;
        this.config.store.patchSessionGoal(threadId, { status: 'paused' });
        log.info({ threadId }, 'goal paused');
        return { ...row, status: 'paused' };
    }

    resume(threadId: string): SessionGoalRow | null {
        const row = this.get(threadId);
        if (!row) return null;
        this.config.store.patchSessionGoal(threadId, {
            status: 'active',
            turnsUsed: 0,
            parseFailures: 0,
        });
        log.info({ threadId }, 'goal resumed (counter reset)');
        return { ...row, status: 'active', turnsUsed: 0, parseFailures: 0 };
    }

    clear(threadId: string): boolean {
        const row = this.get(threadId);
        if (!row) return false;
        this.config.store.deleteSessionGoal(threadId);
        log.info({ threadId }, 'goal cleared');
        return true;
    }

    async maybeContinue(args: MaybeContinueArgs): Promise<MaybeContinueResult | null> {
        const row = this.get(args.threadId);
        if (!row) return null;
        if (row.status !== 'active') {
            return {
                shouldContinue: false,
                newStatus: row.status,
                turnsUsed: row.turnsUsed,
                maxTurns: row.maxTurns,
                stopReason: row.status === 'paused' ? 'paused' : 'cleared',
            };
        }

        const nextTurns = row.turnsUsed + 1;
        if (nextTurns > row.maxTurns) {
            this.config.store.patchSessionGoal(args.threadId, { status: 'paused' });
            log.info(
                { threadId: args.threadId, turnsUsed: row.turnsUsed, maxTurns: row.maxTurns },
                'goal paused — budget exhausted',
            );
            return {
                shouldContinue: false,
                newStatus: 'paused',
                turnsUsed: row.turnsUsed,
                maxTurns: row.maxTurns,
                stopReason: 'budget',
            };
        }

        const verdict = await this.judge(row.goal, args.agentReply);
        const now = Date.now();

        if (verdict.verdict === 'skipped') {
            const nextFails = row.parseFailures + 1;
            if (nextFails >= this.maxParseFailures) {
                this.config.store.patchSessionGoal(args.threadId, {
                    status: 'paused',
                    parseFailures: nextFails,
                    lastTurnAt: now,
                    lastVerdict: 'skipped',
                    lastReason: verdict.reason,
                });
                log.warn(
                    { threadId: args.threadId, consecutiveFailures: nextFails },
                    'goal paused — judge parse failures exceeded threshold',
                );
                return {
                    shouldContinue: false,
                    verdict,
                    newStatus: 'paused',
                    turnsUsed: row.turnsUsed,
                    maxTurns: row.maxTurns,
                    stopReason: 'parse_failures',
                };
            }
            this.config.store.patchSessionGoal(args.threadId, {
                turnsUsed: nextTurns,
                parseFailures: nextFails,
                lastTurnAt: now,
                lastVerdict: 'skipped',
                lastReason: verdict.reason,
            });
            return {
                shouldContinue: true,
                continuationPrompt: this.continuationPrompt(row.goal),
                verdict,
                newStatus: 'active',
                turnsUsed: nextTurns,
                maxTurns: row.maxTurns,
            };
        }

        if (verdict.done) {
            this.config.store.patchSessionGoal(args.threadId, {
                status: 'done',
                turnsUsed: nextTurns,
                parseFailures: 0,
                lastTurnAt: now,
                lastVerdict: 'done',
                lastReason: verdict.reason,
            });
            log.info(
                { threadId: args.threadId, reason: verdict.reason },
                'goal done',
            );
            return {
                shouldContinue: false,
                verdict,
                newStatus: 'done',
                turnsUsed: nextTurns,
                maxTurns: row.maxTurns,
                stopReason: 'done',
            };
        }

        this.config.store.patchSessionGoal(args.threadId, {
            turnsUsed: nextTurns,
            parseFailures: 0,
            lastTurnAt: now,
            lastVerdict: 'continue',
            lastReason: verdict.reason,
        });
        return {
            shouldContinue: true,
            continuationPrompt: this.continuationPrompt(row.goal),
            verdict,
            newStatus: 'active',
            turnsUsed: nextTurns,
            maxTurns: row.maxTurns,
        };
    }

    async judge(goal: string, agentReply: string): Promise<GoalJudgeVerdict> {
        const snippet = agentReply.slice(0, JUDGE_RESPONSE_SNIPPET_CHARS);
        const user =
            `Goal:\n${goal}\n\n` +
            `Agent's most recent response:\n${snippet}\n\n` +
            `Is the goal satisfied?`;

        try {
            const signal = AbortSignal.timeout(this.judgeTimeoutMs);
            const response = await this.config.model.invoke(
                [
                    { role: 'system' as const, content: JUDGE_SYSTEM_PROMPT },
                    { role: 'user' as const, content: user },
                ],
                { signal },
            );
            const raw = extractText(response.content);
            const parsed = parseVerdict(raw);
            if (!parsed) {
                log.debug({ raw: raw.slice(0, 400) }, 'goal judge: reply not JSON-parseable');
                return { done: false, reason: 'judge reply was not JSON', verdict: 'skipped' };
            }
            return { ...parsed, verdict: parsed.done ? 'done' : 'continue' };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg }, 'goal judge: model call failed — failing open to continue');
            return { done: false, reason: `judge error: ${msg.slice(0, 200)}`, verdict: 'continue' };
        }
    }

    continuationPrompt(goal: string): string {
        return CONTINUATION_TEMPLATE.replace('{goal}', goal);
    }
}

function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
            if (block && typeof block === 'object' && 'text' in block && typeof (block as { text: unknown }).text === 'string') {
                parts.push((block as { text: string }).text);
            }
        }
        return parts.join('');
    }
    return '';
}

function parseVerdict(raw: string): { done: boolean; reason: string } | null {
    if (!raw) return null;
    const tryParse = (s: string): { done: boolean; reason: string } | null => {
        try {
            const obj = JSON.parse(s) as { done?: unknown; reason?: unknown };
            if (typeof obj.done !== 'boolean') return null;
            return {
                done: obj.done,
                reason: typeof obj.reason === 'string' ? obj.reason : '',
            };
        } catch {
            return null;
        }
    };

    const direct = tryParse(raw.trim());
    if (direct) return direct;

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced && fenced[1]) {
        const inner = tryParse(fenced[1].trim());
        if (inner) return inner;
    }

    const braceMatch = raw.match(/\{[\s\S]*"done"[\s\S]*\}/);
    if (braceMatch) {
        const inner = tryParse(braceMatch[0]);
        if (inner) return inner;
    }

    return null;
}
