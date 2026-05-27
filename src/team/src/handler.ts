import { createLogger, resolveWorkspacePath, workspace } from '@flopsy/shared';
import type {
    AgentCallbacks,
    AgentHandler,
    AgentResult,
    AggregateTaskSummary,
    InboundMedia,
    InvokeRole,
    TaskListFilter,
    TaskStatusSummary,
    ThreadStatusSnapshot,
} from '@flopsy/gateway';
import { emitHook, emitHookAwait, ProactiveDecisionSchema } from '@flopsy/gateway';
import type { AgentDefinition, McpConfig } from '@flopsy/shared';
import type { BaseChatModel, CheckpointStore, BaseTool, ChatMessage, Provider, ContentBlock, ModelRouter, TextBlock, InterceptorTurnContext, InterceptorSessionEndContext, InterceptorContext, MemoryWriteAction } from 'flopsygraph';
import { defaultContextWindowFor } from 'flopsygraph';
import {
    CheckpointManager,
    ModelLoader,
    SqliteCheckpointStore,
    tokenCounter,
} from 'flopsygraph';

import { parseModelString } from './bootstrap';
import {
    transcodeAgentStream,
    type AgentStreamHandle,
} from './handler/stream-transcoder';
import { redactSecrets } from './handler/redact';
import {
    fireTurnStart as fanoutFireTurnStart,
    fireTurnEnd as fanoutFireTurnEnd,
    fireSessionStart as fanoutFireSessionStart,
    fireSessionEnd as fanoutFireSessionEnd,
    fireDelegation as fanoutFireDelegation,
    fireMemoryWrite as fanoutFireMemoryWrite,
} from './handler/interceptor-fanout';
import { ThreadPool } from './handler/thread-pool';
import { McpLifecycle } from './handler/mcp-lifecycle';
import { MemoryBinding } from './handler/memory-binding';
import { GoalLifecycle } from './handler/goal-lifecycle';
import { runSessionExtraction as runExtractionViaModule } from './handler/extraction-runner';
import { createTeamMember, getCompactorStatus, resolveRole, summarizeForCompaction } from './factory';
import type { TeamMember, TeamRosterEntry } from './factory';
import type { Interceptor as FlopsygraphInterceptor } from 'flopsygraph';
import type { MemoryProvider } from 'flopsygraph';
import { getSharedLearningStore, getSharedPairingStore } from './harness';
import { setPairingFacade, setPersonalityFacade, setInsightsFacade, setBranchFacade } from '@flopsy/gateway';
import type { ExtractionResult } from './harness/review';
import { SessionExtractor } from './harness/review';
import { GoalManager, type GoalNotificationKind } from './harness/goals/goal-manager';
import { join as pathJoin } from 'path';
import type { PersonalityRegistry } from './personalities';
import type { BridgedTool } from './mcp';
import type { LearningStore, SessionRow } from './harness';
import { SessionResolver } from './session-resolver';
import { TaskRegistry } from './state/task-registry';
import { PartialResultError } from './tools/spawn-background-task';
import { clearPlanForThread } from './tools/plan';
import type {
    SubAgentFactory,
    SubAgentRunner,
} from './tools/spawn-background-task';

const log = createLogger('team-handler');

const MID_SESSION_EXTRACT_EVERY = (() => {
    const raw = process.env.FLOPSY_MID_SESSION_EXTRACT_EVERY?.trim();
    if (!raw) return 3;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 3;
})();

/**
 * Detect "verified handle" signals in an assistant reply — concrete artifacts
 * (URLs, absolute file paths, status codes, message IDs) that indicate
 * something real happened in the turn. Used to trigger early session
 * extraction on task success (Hermes-style trajectory capture).
 */
const VERIFIED_HANDLE_PATTERNS: readonly RegExp[] = [
    /https?:\/\/[\w.-]+\/[\w./?=&%-]+/i,        // URL with a path (not just a domain)
    /\/[A-Za-z][\w.-]*\/[\w.-]+\.\w{1,8}\b/,    // absolute file path with extension
    /\bHTTP\/\d\.\d\s+2\d\d\b/,                 // explicit "HTTP/1.1 200" style
    /\bstatus[:\s]+2\d\d\b/i,                    // "status: 200" / "status 201"
    /\bmessage[_-]?id[:\s]+[\w-]+\b/i,           // "message_id: ..." / "message-id ..."
    /\bsha-?256[:\s][a-f0-9]{16,}/i,             // hash output
    /\bpr[/\s#]+\d+\s+(merged|opened|closed)\b/i, // "PR #42 merged"
];
function hasVerifiedHandle(text: string): boolean {
    if (!text || text.length < 20) return false;
    for (const re of VERIFIED_HANDLE_PATTERNS) {
        if (re.test(text)) return true;
    }
    return false;
}

const AUTO_PROMOTE_CONFIDENCE = 0.8;

/**
 * Hints rendered verbatim in the proactive agent's `<runtime>` block.
 * Output guidance is mode-aware: only `conditional` fires register `__respond__`;
 * `always`/`silent` emit plain prose. The disabled-tool list mirrors the filter
 * in `factory.ts` when `proactiveMode: true`.
 */
export function buildProactiveRuntimeHints(
    deliveryMode?: 'always' | 'conditional' | 'silent',
): readonly string[] {
    const common = [
        'context: proactive fire (heartbeat / cron / webhook) — no live user is on the other end of this turn.',
        'unavailable: delegate_task (no workers in proactive mode), spawn_background_task, ask_user, react, send_poll, manage_schedule, send_message.',
        'available: memory tools, MCP tools, web_search, __load_tool__ for the long tail.',
    ];

    const outputHint = (() => {
        if (deliveryMode === 'conditional') {
            return 'output: call `__respond__` with the structured ProactiveDecision (deliver+message OR deliver+silenceReason). `__respond__` is a MODEL TOOL CALL, not a Python function — do NOT write `__respond__(...)` inside execute_code; that NameErrors.';
        }
        if (deliveryMode === 'always') {
            return 'output: this is `delivery: always`. There is NO `__respond__` tool registered — emit your final response as plain prose in your last assistant turn. The engine delivers your text directly to the configured channel. Calling `__respond__` will tool-not-found error and waste retries.';
        }
        return 'output: emit your final response as plain prose. There is no `__respond__` tool for this fire. The engine handles delivery (or silent-mode side-effects) from your final text.';
    })();

    return [
        ...common,
        outputHint,
        'output: keep replies tight — proactive turns are pushed to the user, not pulled. One coherent message, no clarifying questions, no meta-status lines like "Message delivered."',
    ];
}

/**
 * Resolve the abort signal for a proactive fire.
 * Default: unlimited (per-call `modelCallTimeoutMs` and `maxIterations` already bound work).
 * Operators can set `FLOPSY_PROACTIVE_TIMEOUT_MS` for a hard wall-clock cap; `0` = unlimited.
 */
export function resolveProactiveTimeoutSignal(): AbortSignal {
    const raw = (process.env.FLOPSY_PROACTIVE_TIMEOUT_MS ?? '').trim();
    if (!raw) {
        return new AbortController().signal;
    }
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) {
        return new AbortController().signal;
    }
    return AbortSignal.timeout(ms);
}

export interface ThreadIdentity {
    readonly userId: string;
    readonly userName?: string;
    readonly domain?: string;
}

export type ThreadResolver = (threadId: string) => Promise<ThreadIdentity> | ThreadIdentity;

export interface TeamHandlerConfig {
    readonly team: ReadonlyArray<AgentDefinition>;
    readonly entryAgentName: string;
    readonly model: BaseChatModel;
    readonly resolveThread: ThreadResolver;
    readonly maxThreads?: number;
    readonly store?: LearningStore;
    readonly memory?: {
        readonly enabled?: boolean;
        readonly userProfileEnabled?: boolean;
        /** Per-namespace char budget for namespaces other than `profile`. */
        readonly memoryCharLimit?: number;
        /** Char budget specifically for the `profile` namespace. */
        readonly userCharLimit?: number;
        readonly embedder?: {
            readonly provider?: 'ollama';
            readonly model?: string;
            readonly baseUrl?: string;
        };
    };

    readonly mcp?: McpConfig;
    /** Pre-built SessionExtractor; prefer `extractorModel`. Kept for tests that mock the extractor. */
    readonly sessionExtractor?: SessionExtractor;
    /** Auxiliary model used by the internally-built SessionExtractor (typically the fast tier). */
    readonly extractorModel?: BaseChatModel;
    readonly modelRouter?: ModelRouter;
    readonly modelRouters?: ReadonlyMap<string, ModelRouter>;
    readonly personalities?: PersonalityRegistry;
    readonly observability?: import('flopsygraph').Observability;
    readonly acp?: import('./acp/types').AcpConfig;
}

interface ThreadEntry {
    readonly entry: TeamMember;
    readonly identity: ThreadIdentity;
    readonly registry: TaskRegistry;
    readonly buildSubAgent: SubAgentFactory;
    lastUsedAt: number;
    activeTurns: number;
    turnNumber: number;
    accumulatedMessages: ChatMessage[];
}

export class TeamHandler implements AgentHandler {
    private readonly config: TeamHandlerConfig;
    private readonly maxThreads: number;
    private readonly store: LearningStore;
    private readonly sessionResolver!: SessionResolver;
    private readonly threads: ThreadPool<ThreadEntry>;
    private readonly entryDef: AgentDefinition;
    private readonly tokens: ReturnType<typeof tokenCounter>;
    // Memory provider resolved once via flopsygraph's registry (file by default;
    // swappable via config.memory.provider). The resolved provider is cached
    // for the process; a load failure is NOT cached, so a transient boot error
    // (e.g. dir not yet created) retries on the next access instead of pinning
    // every future turn to the factory's fallback file tool.
    // Memory is single-user per FLOPSY_HOME — MemoryBinding warns once if a
    // second principal is routed to the same shared file.
    private readonly memoryBinding: MemoryBinding;
    // Kept off state.db: gzipped checkpoint blobs would thrash the learning-store WAL.
    private readonly checkpointer: CheckpointStore;
    private readonly mcp: McpLifecycle;
    private sessionExtractor?: SessionExtractor;
    private readonly goal: GoalLifecycle;
    readonly modelRouter?: ModelRouter;
    readonly modelRouters?: ReadonlyMap<string, ModelRouter>;
    readonly personalities?: PersonalityRegistry;
    private readonly pendingRecapPromises = new Map<string, Promise<string | null>>();
    private readonly midSessionExtractInFlight = new Set<string>();

    constructor(config: TeamHandlerConfig) {
        this.config = config;
        this.maxThreads = config.maxThreads ?? 100;
        this.store = config.store ?? getSharedLearningStore();
        this.sessionExtractor = config.sessionExtractor;
        this.modelRouter = config.modelRouter;
        this.modelRouters = config.modelRouters;
        this.personalities = config.personalities;
        this.threads = new ThreadPool<ThreadEntry>({
            maxThreads: this.maxThreads,
            log,
            onEvict: (entry, threadId) => {
                entry.entry.harnessInterceptor?.flush().catch((err: unknown) => {
                    log.warn({ threadId, err: redactSecrets(err) }, 'eviction flush failed');
                });
                void fanoutFireSessionEnd(
                    entry.entry.interceptors,
                    threadId,
                    'eviction',
                    entry.accumulatedMessages,
                );
            },
        });

        // 24h is well past any sensible spawn timeoutMs (max configured = 2h); kill anything older.
        try {
            const STALE_MS = 24 * 60 * 60 * 1000;
            const killed = this.store.killStaleBackgroundTasks(STALE_MS);
            if (killed > 0) {
                log.info(
                    { killed, staleThresholdMs: STALE_MS },
                    'background_tasks: marked stale running rows as killed at boot',
                );
            }
        } catch (err) {
            log.warn(
                { err: redactSecrets(err) },
                'background_tasks: boot-time stale sweep failed (non-fatal)',
            );
        }

        const pairingStore = getSharedPairingStore();
        setPairingFacade({
            requestCode: (channel, senderId, senderName) =>
                pairingStore.requestCode(channel, senderId, senderName),
            approveByCode: (channel, code) => pairingStore.approveByCode(channel, code),
            approveBySenderId: (channel, senderId, senderName) =>
                pairingStore.approveBySenderId(channel, senderId, senderName),
            revoke: (channel, senderId) => pairingStore.revoke(channel, senderId),
            isApproved: (channel, senderId) => pairingStore.isApproved(channel, senderId),
            listPending: (channel) => pairingStore.listPending(channel),
            listApproved: (channel) => pairingStore.listApproved(channel),
            clearExpired: (channel) => pairingStore.clearExpired(channel),
            clearAllPending: (channel) => pairingStore.clearAllPending(channel),
        });

        if (this.personalities) {
            const personalities = this.personalities;
            // entryDef is assigned later in this constructor; read lazily at call time.
            setPersonalityFacade({
                list: () =>
                    personalities.list().map((p) => ({
                        name: p.name,
                        description: p.description,
                    })),
                getActive: (rawKey) => {
                    // Mirror buildSystemPrompt: sessionPersonality → defaultPersonality → null.
                    const sessionId = this.resolveActiveSessionId(rawKey);
                    const session = sessionId ? this.store.getSessionPersonality(sessionId) : null;
                    if (session) return session;
                    const defaultName = this.entryDef.defaultPersonality ?? null;
                    if (defaultName && personalities.has(defaultName)) return defaultName;
                    return null;
                },
                setActive: (rawKey, name) => {
                    if (name !== null && !personalities.has(name)) return false;
                    const sessionId = this.resolveActiveSessionId(rawKey);
                    if (!sessionId) return false;
                    this.store.setSessionPersonality(sessionId, name);
                    return true;
                },
                evictThread: (rawKey) => {
                    for (const k of [...this.threads.keys()]) {
                        if (k === rawKey || k.startsWith(`${rawKey}#`)) {
                            this.threads.delete(k);
                        }
                    }
                },
            });
        }

        const store = this.store;
        setInsightsFacade({
            snapshot: (rawKey, windowDays) => {
                const peerKey = rawKey.split('#')[0] ?? rawKey;
                const days = Math.max(1, Math.min(Math.floor(windowDays), 365));
                const sinceMs = Date.now() - days * 86_400_000;
                const sinceDateIso = new Date(sinceMs).toISOString().slice(0, 10);

                const messages = store.getMessageCountForPeer(peerKey, sinceMs);
                const sessionStats = store.getSessionStatsForPeer(peerKey, sinceMs, 5);
                const tokens = store.getTokenUsageForPeer(peerKey, sinceDateIso);
                const recent = store.getRecentClosedSessionsWithSummary(peerKey, sinceMs, 5);

                if (
                    messages.total === 0 &&
                    sessionStats.count === 0 &&
                    tokens.length === 0
                ) {
                    return null;
                }

                return {
                    windowDays: days,
                    sinceMs,
                    activity: {
                        sessions: sessionStats.count,
                        turns: sessionStats.totalTurns,
                        messagesTotal: messages.total,
                        messagesUser: messages.user,
                        messagesAssistant: messages.assistant,
                    },
                    tokens: tokens.map((t) => ({
                        provider: t.provider,
                        model: t.model,
                        input: t.input,
                        output: t.output,
                        calls: t.calls,
                    })),
                    longestSessions: sessionStats.longest.map((s) => ({
                        sessionId: s.sessionId,
                        turnCount: s.turnCount,
                        openedAt: s.openedAt,
                        closedAt: s.closedAt,
                        summary: s.summary,
                    })),
                    recentSessions: recent
                        .filter((s) => s.summary !== null && s.closedAt !== null)
                        .map((s) => ({
                            sessionId: s.sessionId,
                            closedAt: s.closedAt!,
                            summary: s.summary!,
                        })),
                };
            },
        });

        setBranchFacade({
            fork: (rawKey, label) => this.branchSession(rawKey, label),
            switch: (rawKey, label) => this.switchBranch(rawKey, label),
            list: (rawKey) => {
                const peerKey = rawKey.split('#')[0] ?? rawKey;
                const activeId = this.store.getActiveSession(peerKey)?.sessionId ?? null;
                return this.listBranches(rawKey).map((s) => ({
                    sessionId: s.sessionId,
                    label: s.branchLabel,
                    active: s.sessionId === activeId,
                    turnCount: s.turnCount,
                    summary: s.summary,
                    lastUserMessageAt: s.lastUserMessageAt,
                }));
            },
        });

        this.sessionResolver = new SessionResolver(this.store);
        this.checkpointer = new SqliteCheckpointStore({
            path: resolveWorkspacePath('state', 'checkpoints.db'),
            compress: true,
            keepLatestPerThread: 60,
        });

        // Build the SessionExtractor against our checkpointer when bootstrap
        // supplied an `extractorModel` rather than a pre-built extractor.
        if (!this.sessionExtractor && config.extractorModel) {
            this.sessionExtractor = new SessionExtractor({
                model: config.extractorModel,
                checkpointer: this.checkpointer,
            });
        }

        this.goal = new GoalLifecycle({
            ...(config.extractorModel ? { extractorModel: config.extractorModel } : {}),
            store: this.store,
        });


        this.tokens = tokenCounter({
            keyFn: (ctx) =>
                (ctx.configurable as { threadId?: string })?.threadId ?? ctx.threadId,
            persistAcrossGraphEnd: true,
            onUpdate: (threadId, delta, _cumulative, ctx, response) => {
                try {
                    const date = localDateString();
                    const fallback = (response.raw as Record<string, unknown> | undefined)?.['_fallbackTo'] as
                        { provider?: string; model?: string } | undefined;
                    const provider = fallback?.provider ?? ctx.provider;
                    const model = fallback?.model ?? ctx.model;
                    if (!provider || !model) {
                        log.debug(
                            { threadId, provider, model, ctxProvider: ctx.provider, ctxModel: ctx.model },
                            'token_usage skipped — provider/model undefined',
                        );
                        return;
                    }
                    if (delta.input === 0 && delta.output === 0) {
                        return;
                    }
                    this.store.recordTokenUsage({
                        threadId,
                        date,
                        provider,
                        model,
                        input: delta.input,
                        output: delta.output,
                    });
                } catch (err) {
                    log.warn(
                        { err: redactSecrets(err), threadId },
                        'token_usage write failed (token-counter swallows by default — non-fatal)',
                    );
                }
            },
        });

        this.mcp = new McpLifecycle(config.mcp);
        this.mcp.initialize();
        this.memoryBinding = new MemoryBinding({
            config: config.memory,
            checkpointer: this.checkpointer,
            onMemoryWrite: (action, target, content, metadata) =>
                fanoutFireMemoryWrite(
                    [...this.threads.values()].map((e) => e.entry.interceptors),
                    action,
                    target,
                    content,
                    metadata,
                ),
        });

        const entry = config.team.find((a) => a.name === config.entryAgentName);
        if (!entry) {
            const names = config.team.map((a) => a.name).join(', ');
            throw new Error(
                `TeamHandler: entry agent "${config.entryAgentName}" not in team. ` +
                    `Team: [${names}]`,
            );
        }
        this.entryDef = entry;

        log.info(
            {
                entry: entry.name,
                teammates: config.team.map((a) => a.name),
                enabled: config.team.filter((a) => a.enabled).map((a) => a.name),
            },
            'TeamHandler ready',
        );
    }

    getGoalManager(): GoalManager | undefined {
        return this.goal.getManager();
    }

    setGoalContinuationCallback(
        cb: (args: { threadId: string; channelName: string; peerId: string; prompt: string }) => void,
    ): void {
        this.goal.setContinuationCallback(cb);
    }

    setGoalNotificationCallback(
        cb: (args: {
            threadId: string;
            channelName: string;
            peerId: string;
            kind: GoalNotificationKind;
            message: string;
        }) => void,
    ): void {
        this.goal.setNotificationCallback(cb);
    }

    async invoke(
        text: string,
        threadId: string,
        callbacks: AgentCallbacks,
        role: InvokeRole = 'user',
        media?: ReadonlyArray<InboundMedia>,
    ): Promise<AgentResult> {
        threadId = this.resolveSessionThreadId(threadId, role);

        // Race the queued recap against an 8s window so a slow LLM doesn't hold up the user's turn.
        const RECAP_INJECT_TIMEOUT_MS = 8_000;
        let awayRecap: string | null = null;
        const recapPromise = this.pendingRecapPromises.get(threadId);
        if (recapPromise && role === 'user') {
            this.pendingRecapPromises.delete(threadId);
            awayRecap = await Promise.race([
                recapPromise,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), RECAP_INJECT_TIMEOUT_MS)),
            ]);
            if (awayRecap) {
                log.info({ threadId, chars: awayRecap.length }, 'away recap injected into first turn');
            }
        }

        const entry = await this.getOrCreateThread(threadId, {
            isProactive: callbacks.channelName === 'proactive',
            // Drives outputSchema gating in createTeamMember (conditional → schema; else → prose).
            ...(callbacks.deliveryMode ? { deliveryMode: callbacks.deliveryMode } : {}),
        });
        entry.lastUsedAt = Date.now();

        // Resume-on-restart: read whether a prior turn was interrupted (flag survived
        // a restart), then flag THIS turn in-flight. Cleared on a non-aborted end below.
        const resumePeerId = threadId.split('#')[0] ?? threadId;
        const wasInterrupted = this.store.isResumePending(resumePeerId);
        this.store.markResumePending(resumePeerId);

        entry.activeTurns += 1;
        entry.turnNumber += 1;
        const turnCtx: InterceptorTurnContext = {
            runId: `turn-${threadId}-${entry.turnNumber}`,
            threadId,
            signal: callbacks.signal,
            configurable: {},
            store: new Map<string, unknown>(),
            turnNumber: entry.turnNumber,
            userMessage: text,
            ...(callbacks.channelName ? { platform: callbacks.channelName } : {}),
        };
        await fanoutFireTurnStart(entry.entry.interceptors, turnCtx);
        try {
            const configurable: Record<string, unknown> = {
                onReply: callbacks.onReply,
                sendPoll: callbacks.sendPoll,
                drainPending: callbacks.drainPending,
                setDidSendViaTool: callbacks.setDidSendViaTool,
                reactToUserMessage: callbacks.reactToUserMessage,
                eventQueue: callbacks.eventQueue,
                registry: entry.registry,
                buildSubAgent: entry.buildSubAgent,
                depth: 0,
                threadId,
                userId: entry.identity.userId,
                store: this.store,
                checkpointer: this.checkpointer,
                // Search summarization runs on the fast tier (same model as
                // SessionExtractor — typically a cheaper / higher-throughput
                // tier than the main agent's deepseek-v4-pro). Avoids 503s
                // from the primary provider being saturated by main-loop
                // reasoning, and matches the practice of using an auxiliary
                // model for compression work.
                summaryModel: this.config.extractorModel ?? this.config.model,
                channelName: callbacks.channelName,
                channelCapabilities: callbacks.channelCapabilities,
                peer: callbacks.peer,
                sender: callbacks.sender,
                messageId: callbacks.messageId,
                personality: callbacks.personality,
                runtimeHints: callbacks.runtimeHints,
                taskStore: this.store,
                runStore: this.store,
                acp: this.config.acp,
                onDelegationComplete: (task: string, result: string, childSessionId: string) =>
                    fanoutFireDelegation(
                        this.threads.get(threadId)?.entry.interceptors ?? [],
                        threadId,
                        task,
                        result,
                        childSessionId,
                    ),
                skillUsageStore: entry.entry.skillUsageStore,
                onAuthSuccess: (provider: string) => {
                    // Fire-and-forget; awaiting would block the user's turn for 5-30s on slow MCP restart.
                    if (!this.mcp.hasServers()) return;
                    void (async () => {
                        let affected: readonly string[] = [];
                        try {
                            affected = await this.mcp.restartAfterAuth(provider);
                            if (affected.length === 0) return;
                            log.info({ provider, servers: affected }, 'reloading mcp servers after auth (background)');
                        } catch (err) {
                            log.warn(
                                { provider, servers: affected, err: err instanceof Error ? err.message : String(err) },
                                'onAuthSuccess mcp restart failed — notifying user',
                            );
                            try {
                                const serverList = affected.length > 0 ? affected.join(', ') : provider;
                                await callbacks.onReply(
                                    `✓ Authorized ${provider}, but couldn't restart the connector (${serverList}). Try /doctor, or message me again in ~30s.`,
                                );
                            } catch (sendErr) {
                                log.error(
                                    { provider, sendErr: sendErr instanceof Error ? sendErr.message : String(sendErr) },
                                    'failed to notify user about MCP restart failure — they have no signal',
                                );
                            }
                        }
                    })();
                },
            };

            let effectiveText = awayRecap
                ? `[Continuity context — recap of your last session with this user: ${awayRecap}]\n[How to use this: if the user opens with a casual greeting like "hey", "how is everything", "what's up" — DO NOT reply with a generic "How can I help today?". Reference the recap: name what was in flight and ask if they want to continue, or proactively check the next step. If the user asks a direct question, answer it AND, if the recap mentions a pending follow-up, mention it briefly. Only ignore the recap if it's plainly irrelevant to what they just said.]\n\n${text}`
                : text;
            if (wasInterrupted) {
                log.info({ threadId, resumePeerId }, 'resume-on-restart: prior turn was interrupted — injecting recovery note');
                effectiveText = `[Restart recovery — the gateway restarted while you were mid-task and didn't finish replying to this user. The recent messages above are that conversation. Pick up where you left off and finish what they were waiting for — don't make them re-ask. If you genuinely can't tell what was pending, say you were interrupted by a restart and ask them to confirm.]\n\n${effectiveText}`;
            }
            const content = buildContent(effectiveText, media);

            const stream = (entry.entry.agent as unknown as AgentStreamHandle).stream(
                { messages: [{ role, content }] },
                { threadId, signal: callbacks.signal, configurable },
            );

            // Snapshot pre-turn token totals (tokenCounter is cumulative per threadId).
            const tokensBefore = this.tokens.getTotals(threadId)
                ?? { input: 0, output: 0, reasoning: 0, cached: 0, calls: 0 };

            const resultState = await transcodeAgentStream(stream, callbacks.onChunk);

            if (!resultState) {
                throw new Error('agent stream completed without a result event');
            }
            const result = resultState as {
                messages?: unknown;
                tokenUsage?: unknown;
                stoppedByLimit?: unknown;
                toolStepCount?: unknown;
                // Populated when agent has outputSchema and called __respond__; read only by proactive path.
                structured?: unknown;
            };

            const messages =
                (result.messages as unknown as Array<{ role: string; content: unknown }>) ?? [];
            const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

            const baseReply = lastAssistant
                ? typeof lastAssistant.content === 'string'
                    ? lastAssistant.content
                    : JSON.stringify(lastAssistant.content)
                : null;

            const stoppedByLimit = result.stoppedByLimit === true;
            const toolStepCount =
                typeof result.toolStepCount === 'number' ? result.toolStepCount : undefined;
            const reply =
                baseReply && stoppedByLimit
                    ? `${baseReply}\n\n_(I stopped after ${toolStepCount ?? 'too many'} tool calls — say "continue" if you want me to keep going.)_`
                    : baseReply;

            const tokensAfter = this.tokens.getTotals(threadId)
                ?? { input: 0, output: 0, reasoning: 0, cached: 0, calls: 0 };
            const turnDelta = {
                promptTokens: Math.max(0, tokensAfter.input - tokensBefore.input),
                completionTokens: Math.max(0, tokensAfter.output - tokensBefore.output),
                reasoningTokens: Math.max(0, tokensAfter.reasoning - tokensBefore.reasoning),
                cachedTokens: Math.max(0, tokensAfter.cached - tokensBefore.cached),
            };
            const stateUsage = result.tokenUsage as unknown as
                | { promptTokens: number; completionTokens: number; reasoningTokens?: number; cachedTokens?: number }
                | undefined;
            const usage = stateUsage ?? (turnDelta.promptTokens + turnDelta.completionTokens > 0 ? turnDelta : undefined);

            if (role === 'user') {
                const peerId = threadId.split('#')[0] ?? threadId;
                emitHook('turn.user.received', {
                    peerId,
                    threadId,
                    replyLength: reply?.length ?? 0,
                    promptTokens: usage?.promptTokens ?? 0,
                    completionTokens: usage?.completionTokens ?? 0,
                });
                try {
                    this.sessionResolver.touch(peerId, 'user');
                } catch (err) {
                    log.warn(
                        { threadId, err: redactSecrets(err), op: 'session.touch' },
                        'failed to touch session — turn_count + freshness may drift',
                    );
                }

                if (this.sessionExtractor && !this.midSessionExtractInFlight.has(peerId)) {
                    try {
                        const active = this.store.getActiveSession(peerId);
                        // Trigger A: every-N-turn cadence (existing behavior)
                        const cadenceHit = active
                            && active.turnCount > 0
                            && active.turnCount % MID_SESSION_EXTRACT_EVERY === 0;
                        // Trigger B (NEW): task-success heuristic — when the reply
                        // contains a "verified handle" (URL / file path / message-id /
                        // 2xx status) AND the session has ≥3 turns of substance, fire
                        // extraction immediately. Aligns with Hermes's trajectory-based
                        // skill capture: real procedural patterns produce concrete
                        // outputs; the moment they appear is the best time to
                        // crystallize them as a skill.
                        const taskSuccessHit = active
                            && active.turnCount >= 3
                            && !cadenceHit  // don't double-fire
                            && active.turnCount % 3 === 0  // throttle: at most every 3 turns
                            && hasVerifiedHandle(reply ?? '');
                        if (active && (cadenceHit || taskSuccessHit)) {
                            const sid = active.sessionId;
                            this.midSessionExtractInFlight.add(peerId);
                            log.debug(
                                {
                                    threadId,
                                    turnCount: active.turnCount,
                                    trigger: cadenceHit ? 'cadence' : 'task-success',
                                },
                                'session extraction triggered',
                            );
                            void this.runSessionExtraction(threadId, sid, peerId)
                                .catch((err) =>
                                    log.debug(
                                        { threadId, err: redactSecrets(err) },
                                        'mid-session extraction failed (non-fatal)',
                                    ),
                                )
                                .finally(() => this.midSessionExtractInFlight.delete(peerId));
                        }
                    } catch (err) {
                        log.debug(
                            { threadId, err: redactSecrets(err) },
                            'mid-session extraction check failed (non-fatal)',
                        );
                    }
                }

                if (reply) {
                    this.goal.dispatchPostTurn({
                        threadId,
                        peerId,
                        channelName: callbacks.channelName,
                        agentReply: reply,
                    });
                }
            }

            await fanoutFireTurnEnd(entry.entry.interceptors, turnCtx, reply ?? '');
            emitHook('turn.assistant.completed', {
                peerId: threadId.split('#')[0] ?? threadId,
                threadId,
                replyLength: reply?.length ?? 0,
                promptTokens: usage?.promptTokens ?? 0,
                completionTokens: usage?.completionTokens ?? 0,
            });
            return {
                reply,
                didSendViaTool: false,
                tokenUsage: usage
                    ? {
                        input: usage.promptTokens,
                        output: usage.completionTokens,
                        ...(usage.reasoningTokens ? { reasoning: usage.reasoningTokens } : {}),
                        ...(usage.cachedTokens ? { cached: usage.cachedTokens } : {}),
                    }
                    : undefined,
                ...(result.structured !== undefined ? { structured: result.structured } : {}),
            };
        } catch (err) {
            if (callbacks.signal.aborted) {
                log.debug({ threadId }, 'agent invoke aborted');
                return { reply: null, didSendViaTool: false };
            }
            log.error({ threadId, err: redactSecrets(err) }, 'agent invoke failed');
            throw err;
        } finally {
            entry.activeTurns -= 1;
            // Clear the resume flag only on a NON-aborted end. A shutdown abort (or a
            // process kill, where this never runs) leaves it set so the next message
            // resumes the interrupted task.
            if (!callbacks.signal.aborted) {
                try { this.store.clearResumePending(resumePeerId); } catch { /* best-effort */ }
            }
            try { entry.registry.evictTerminal(); } catch { /* */ }
        }
    }

/**
     * Stateless single-agent invocation for proactive fires: fresh agent per call,
     * no thread cache, no worker team, no delegate/spawn/ask_user tools.
     */
    /**
     * Resolve the memory provider once through flopsygraph's registry. Memoized
     * across all team-member builds. On load failure (bad config, ping fail) we
     * log and return undefined so `createTeamMember` falls back to its direct
     * file-tool construction — memory routing should degrade, not crash the agent.
     */
    private buildMemoryPlugins(): Promise<FlopsygraphInterceptor[]> {
        return this.memoryBinding.buildPlugins();
    }

    private getMemoryProvider(userId?: string): Promise<MemoryProvider | undefined> {
        return this.memoryBinding.getProvider(userId);
    }

    async invokeStateless(
        text: string,
        threadId: string,
        options: {
            readonly deliveryMode?: 'always' | 'conditional' | 'silent';
            readonly signal?: AbortSignal;
            readonly personality?: string;
            readonly runtimeHints?: ReadonlyArray<string>;
        } = {},
    ): Promise<AgentResult> {
        const memoryCharLimits: Record<string, number> = (() => {
            const memCfg = this.config.memory ?? {};
            const memLim = memCfg.memoryCharLimit ?? 2200;
            const usrLim = memCfg.userCharLimit ?? 1375;
            return { user: usrLim, memory: memLim };
        })();

        // Reuse the cached entry's MCP filter so proactive sees the same surface for __load_tool__.
        const allMcpTools = await this.mcp.getReadyTools();
        const filteredMcpTools = this.mcp.filterForAgent(
            allMcpTools,
            this.entryDef.name,
            this.entryDef.mcpServers,
        );
        const { staticMcpTools, dynamicMcpTools } = this.mcp.partitionByPreload(filteredMcpTools);
        const mcpTools = dynamicMcpTools as unknown as BaseTool[];
        const mcpPreloadedTools = staticMcpTools as unknown as BaseTool[];

        const identity = await this.config.resolveThread(threadId);
        const memoryStore = await this.getMemoryProvider(identity.userId);

        const member = createTeamMember(this.entryDef, {
            model: this.config.model,
            userId: identity.userId,
            userName: identity.userName,
            store: this.store,
            memoryCharLimits,
            ...(memoryStore ? { memoryStore } : {}),
            extraInterceptors: [this.tokens, ...(await this.buildMemoryPlugins())],
            checkpointer: this.checkpointer,
            extraTools: mcpPreloadedTools.length > 0 ? mcpPreloadedTools : undefined,
            extraDynamicTools: mcpTools,
            // Empty roster — `delegate_task` is filtered by `proactiveMode`,
            // but pass [] so anything else that consults teamRoster sees the
            // expected "no workers visible" shape.
            teamRoster: [],
            mainAgentName: this.entryDef.name,
            personalities: this.personalities,
            modelCallTimeoutMs: 180_000,
            // Strips delegate_task, spawn_background_task, ask_user, react, send_poll, manage_schedule.
            proactiveMode: true,
            isProactive: true,
            ...(options.deliveryMode === 'conditional'
                ? { outputSchema: ProactiveDecisionSchema }
                : {}),
            ...(this.config.observability ? { observability: this.config.observability } : {}),
        });

        const signal = options.signal ?? resolveProactiveTimeoutSignal();
        const registry = new TaskRegistry();

        // Channel callbacks are no-ops; proactive turns deliver via the engine's channel router.
        const configurable: Record<string, unknown> = {
            onReply: async () => {},
            sendPoll: async () => {},
            drainPending: () => [] as string[],
            setDidSendViaTool: () => {},
            reactToUserMessage: async () => {},
            eventQueue: {
                push: () => {},
                tryDequeue: () => null,
                waitForEvent: async () => false,
            },
            registry,
            buildSubAgent: () => {
                throw new Error('proactive single-agent fire cannot delegate to workers — delegate_task was filtered');
            },
            depth: 0,
            threadId,
            userId: identity.userId,
            store: this.store,
            checkpointer: this.checkpointer,
            summaryModel: this.config.extractorModel ?? this.config.model,
            channelName: 'proactive',
            channelCapabilities: [] as readonly string[],
            peer: { id: 'proactive', type: 'user' as const },
            taskStore: this.store,
            skillUsageStore: member.skillUsageStore,
            ...(options.personality ? { personality: options.personality } : {}),
            ...(options.runtimeHints
                ? { runtimeHints: options.runtimeHints }
                : { runtimeHints: buildProactiveRuntimeHints(options.deliveryMode) }),
            ...(options.deliveryMode ? { deliveryMode: options.deliveryMode } : {}),
        };

        const tokensBefore = this.tokens.getTotals(threadId)
            ?? { input: 0, output: 0, reasoning: 0, cached: 0, calls: 0 };

        try {
            const stream = (member.agent as unknown as AgentStreamHandle).stream(
                { messages: [{ role: 'user', content: text }] },
                { threadId, signal, configurable },
            );

            const resultState = await transcodeAgentStream(stream);

            if (!resultState) {
                throw new Error('proactive agent stream completed without a result event');
            }

            const result = resultState as {
                messages?: unknown;
                tokenUsage?: unknown;
                stoppedByLimit?: unknown;
                toolStepCount?: unknown;
                structured?: unknown;
            };

            const messages =
                (result.messages as unknown as Array<{ role: string; content: unknown }>) ?? [];
            const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
            const reply = lastAssistant
                ? typeof lastAssistant.content === 'string'
                    ? lastAssistant.content
                    : JSON.stringify(lastAssistant.content)
                : null;

            // [SILENT] sentinel: text-token contract documented in
            // `src/team/templates/roles/main/proactive.md`. Detection only — the
            // raw `[SILENT]` reply is propagated unchanged so the proactive
            // executor's `isSilentSentinel` check (the canonical gate) sees it
            // and finalizes with `silenceReason: 'silent_sentinel'`. Logging
            // here only aids debugging when the stateless path is exercised in
            // isolation; suppression itself happens at the executor.
            if (typeof reply === 'string' && reply.trim() === '[SILENT]') {
                log.info(
                    { threadId, deliveryMode: options.deliveryMode },
                    'proactive stateless: [SILENT] sentinel detected (executor will suppress)',
                );
            }

            const tokensAfter = this.tokens.getTotals(threadId)
                ?? { input: 0, output: 0, reasoning: 0, cached: 0, calls: 0 };
            const turnDelta = {
                promptTokens: Math.max(0, tokensAfter.input - tokensBefore.input),
                completionTokens: Math.max(0, tokensAfter.output - tokensBefore.output),
                reasoningTokens: Math.max(0, tokensAfter.reasoning - tokensBefore.reasoning),
                cachedTokens: Math.max(0, tokensAfter.cached - tokensBefore.cached),
            };
            const stateUsage = result.tokenUsage as unknown as
                | { promptTokens: number; completionTokens: number; reasoningTokens?: number; cachedTokens?: number }
                | undefined;
            const usage = stateUsage ?? (turnDelta.promptTokens + turnDelta.completionTokens > 0 ? turnDelta : undefined);

            log.info(
                {
                    threadId,
                    op: 'proactive:stateless-return',
                    hasStructured: result.structured !== undefined,
                    replyLength: reply?.length ?? 0,
                    deliveryMode: options.deliveryMode,
                },
                'proactive stateless agent returned',
            );

            return {
                reply,
                didSendViaTool: false,
                tokenUsage: usage
                    ? {
                        input: usage.promptTokens,
                        output: usage.completionTokens,
                        ...(usage.reasoningTokens ? { reasoning: usage.reasoningTokens } : {}),
                        ...(usage.cachedTokens ? { cached: usage.cachedTokens } : {}),
                    }
                    : undefined,
                ...(result.structured !== undefined ? { structured: result.structured } : {}),
            };
        } catch (err) {
            if (signal.aborted) {
                log.debug({ threadId }, 'proactive stateless invoke aborted');
                return { reply: null, didSendViaTool: false };
            }
            log.error({ threadId, err: redactSecrets(err) }, 'proactive stateless invoke failed');
            throw err;
        }
    }

    get activeThreadCount(): number {
        return this.threads.size;
    }

    queryStatus(rawKey: string): ThreadStatusSnapshot | undefined {
        // Try exact match then prefix search: threads keyed as "rawKey#sessionId".
        let entry = this.threads.get(rawKey);
        if (!entry) {
            for (const [threadId, e] of this.threads) {
                if (isThreadForRawKey(threadId, rawKey)) { entry = e; break; }
            }
        }
        const threadId = rawKey;

        if (!entry) {
            const today = localDateString();
            const todayTotal = this.store.getTokenDailyTotal(threadId, today);
            const byModelAll = this.store.getTokenDailyByModel(threadId, today);
            const byModel = byModelAll.slice(0, 5).map((m) => ({
                provider: m.provider,
                model: m.model,
                input: m.input,
                output: m.output,
                calls: m.calls,
            }));

            const team = this.config.team
                .filter((a) => resolveRole(a) === 'worker')
                .map((def): import('@flopsy/gateway').TeamMemberStatus => ({
                    name: def.name,
                    type: def.type,
                    enabled: def.enabled,
                    status: def.enabled ? 'idle' : 'disabled',
                    ...staticConfigFields(def),
                }));

            const persistedTasks = this.store.listBackgroundTasksForThread(
                threadId,
                ['completed', 'delivered', 'failed', 'killed'],
            )
                .slice(-5)
                .reverse()
                .map((t): TaskStatusSummary => ({
                    id: t.taskId,
                    worker: t.workerName,
                    description: t.description ?? t.taskPrompt.slice(0, 80),
                    status: t.status === 'delivered' ? 'completed' : t.status,
                    startedAtMs: t.createdAt,
                    endedAtMs: t.endedAt ?? undefined,
                    error: t.error ?? undefined,
                }));

            return {
                threadId,
                entryAgent: this.entryDef.name,
                activeTasks: [],
                recentTasks: persistedTasks,
                tokens:
                    todayTotal.calls > 0
                        ? {
                              input: todayTotal.input,
                              output: todayTotal.output,
                              calls: todayTotal.calls,
                              byModel,
                          }
                        : undefined,
                team: team.length > 0 ? team : undefined,
            };
        }

        const tasks = entry.registry.list();
        const active: TaskStatusSummary[] = [];
        const recent: TaskStatusSummary[] = [];

        for (const t of tasks) {
            const summary: TaskStatusSummary = {
                id: t.id,
                worker: t.type === 'teammate' ? t.workerName : t.type,
                description: t.description,
                status: t.status,
                startedAtMs: t.createdAt,
                endedAtMs: t.endedAt,
                error: t.error,
            };
            if (t.status === 'pending' || t.status === 'running' || t.status === 'idle') {
                active.push(summary);
            } else {
                recent.push(summary);
            }
        }

        recent.sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0));
        recent.length = Math.min(recent.length, 5);

        const today = localDateString();
        const todayTotal = this.store.getTokenDailyTotal(threadId, today);
        const byModelAll = this.store.getTokenDailyByModel(threadId, today);
        const byModel = byModelAll.slice(0, 5).map((m) => ({
            provider: m.provider,
            model: m.model,
            input: m.input,
            output: m.output,
            calls: m.calls,
        }));

        const now = Date.now();

        const lastActiveByWorker = new Map<string, number>();
        for (const t of tasks) {
            if (t.type !== 'teammate' || !t.workerName || t.endedAt == null) continue;
            const prev = lastActiveByWorker.get(t.workerName) ?? 0;
            if (t.endedAt > prev) lastActiveByWorker.set(t.workerName, t.endedAt);
        }
        const team = this.config.team
            .map((def): import('@flopsy/gateway').TeamMemberStatus => {
                const staticFields = staticConfigFields(def);
                if (!def.enabled) {
                    return {
                        name: def.name,
                        type: def.type,
                        enabled: false,
                        status: 'disabled',
                        ...staticFields,
                    };
                }
                const activeTask = tasks.find(
                    (t) =>
                        t.type === 'teammate' &&
                        t.workerName === def.name &&
                        (t.status === 'pending' || t.status === 'running'),
                );
                const lastActiveAt = lastActiveByWorker.get(def.name);
                if (activeTask) {
                    return {
                        name: def.name,
                        type: def.type,
                        enabled: true,
                        status: 'running',
                        currentTask: {
                            id: activeTask.id,
                            description: activeTask.description,
                            runningMs: now - activeTask.createdAt,
                        },
                        ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
                        ...staticFields,
                    };
                }
                return {
                    name: def.name,
                    type: def.type,
                    enabled: true,
                    status: 'idle',
                    ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
                    ...staticFields,
                };
            });

        return {
            threadId,
            entryAgent: entry.entry.name,
            activeTasks: active,
            recentTasks: recent,
            tokens:
                todayTotal.calls > 0
                    ? {
                          input: todayTotal.input,
                          output: todayTotal.output,
                          calls: todayTotal.calls,
                          byModel,
                      }
                    : undefined,
            team: team.length > 0 ? team : undefined,
        };
    }

    getCompactorStatus(threadId: string) {
        const c = getCompactorStatus(this.entryDef.name, threadId);
        if (!c) return undefined;
        const { tokens, threshold, percentUsed, tokensRemaining, willCompactNext } = c;
        return { tokens, threshold, percentUsed, tokensRemaining, willCompactNext };
    }

    /**
     * Effective context window for this agent's model. Used by the channel
     * worker to populate `contextLimit` on the CLI's progress bar even before
     * the compactor has logged a check for the thread. Without this, the
     * progress bar gets `0` for limit and falls back to the bare-number
     * rendering (`ctx 718.4K ⚠`) instead of the bar form.
     */
    getModelContextWindow(): number {
        // entryDef.model is the config-level model string (e.g.
        // "nvidia:nvidia/nemotron-3-super-120b-a12b"), not the BaseChatModel
        // instance. Pass it straight through; defaultContextWindowFor strips
        // the provider prefix and matches against KNOWN_WINDOWS.
        const m = this.entryDef.model;
        const name = typeof m === 'string'
            ? m
            : (m as unknown as { modelId?: string; id?: string; name?: string })?.modelId
            ?? (m as unknown as { id?: string })?.id
            ?? (m as unknown as { name?: string })?.name
            ?? '';
        return defaultContextWindowFor(name);
    }

    async evictThread(threadId: string): Promise<void> {
        const entry = this.threads.get(threadId);
        if (!entry) return;
        try {
            await entry.entry.harnessInterceptor?.flush();
            const agentHandle = entry.entry.agent as { dispose?: () => Promise<void> } | undefined;
            if (agentHandle?.dispose) {
                await agentHandle.dispose().catch((err) =>
                    log.warn({ threadId, err }, 'agent dispose failed'),
                );
            } else {
                await entry.entry.sandboxSession?.close().catch((err) =>
                    log.warn({ threadId, err }, 'sandbox session close failed'),
                );
            }
        } finally {
            this.threads.delete(threadId);
        }
    }

    queryAllTasks(filter: TaskListFilter = {}): AggregateTaskSummary[] {
        const statusFilter = filter.status ? new Set(filter.status) : null;
        const out: AggregateTaskSummary[] = [];
        for (const [threadId, entry] of this.threads) {
            if (filter.threadId && threadId !== filter.threadId) continue;
            for (const t of entry.registry.list()) {
                if (statusFilter && !statusFilter.has(t.status)) continue;
                out.push({
                    threadId,
                    id: t.id,
                    worker: t.type === 'teammate' ? t.workerName : t.type,
                    description: t.description,
                    status: t.status,
                    startedAtMs: t.createdAt,
                    endedAtMs: t.endedAt,
                    error: t.error,
                });
            }
        }
        out.sort((a, b) => {
            const aActive = a.status === 'pending' || a.status === 'running' || a.status === 'idle';
            const bActive = b.status === 'pending' || b.status === 'running' || b.status === 'idle';
            if (aActive !== bActive) return aActive ? -1 : 1;
            if (aActive) return b.startedAtMs - a.startedAtMs;
            return (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0);
        });
        if (filter.limit && out.length > filter.limit) out.length = filter.limit;
        return out;
    }

    async shutdown(): Promise<void> {
        const entries = this.threads.drain();
        await Promise.allSettled(
            entries.map((e) => e.entry.harnessInterceptor?.flush() ?? Promise.resolve()),
        );
        // WAL checkpoint on shutdown — otherwise next boot replays it.
        const closable = this.checkpointer as { close?: () => void | Promise<void> };
        if (typeof closable.close === 'function') {
            try {
                await closable.close();
            } catch (err) {
                log.warn({ err: redactSecrets(err) }, 'checkpoint store close failed');
            }
        }
        try {
            await this.mcp.close();
        } catch (err) {
            log.warn({ err: redactSecrets(err) }, 'mcp shutdown failed');
        }
    }

    private resolveSessionThreadId(rawKey: string, role: InvokeRole): string {
        if (rawKey.includes('#')) return rawKey;
        const parts = rawKey.split(':');
        if (parts.length < 3) return rawKey;
        const [channel, scope, ...rest] = parts;
        const peerNativeId = rest.join(':');
        if (!channel || !scope || !peerNativeId) return rawKey;

        const source = role === 'user' ? 'user' : 'cron';
        try {
            const result = this.sessionResolver.resolve(
                rawKey,
                { channel, scope, peerNativeId },
                { source },
            );

            if (
                result.isNew &&
                result.previousSessionId &&
                result.closeReason !== 'migration' &&
                this.sessionExtractor
            ) {
                const prevThreadId = `${result.peerId}#${result.previousSessionId}`;
                const prevSessionId = result.previousSessionId;
                const peerId = result.peerId;
                // Fire-and-forget; feeds pendingRecapPromises for first-turn race.
                const summaryPromise = this.runSessionExtraction(prevThreadId, prevSessionId, peerId)
                    .then((r) => r?.summary ?? null)
                    .catch(() => null);
                this.pendingRecapPromises.set(result.threadId, summaryPromise);
                log.debug(
                    {
                        peerId,
                        prevThreadId,
                        newThreadId: result.threadId,
                        closeReason: result.closeReason,
                    },
                    'session rotated: extraction queued',
                );
            }

            return result.threadId;
        } catch (err) {
            log.warn(
                { err: redactSecrets(err), rawKey },
                'session resolution failed — falling back to raw threadId',
            );
            return rawKey;
        }
    }

    private resolveActiveSessionId(rawKey: string): string | null {
        const peerKey = rawKey.split('#')[0] ?? rawKey;
        const active = this.store.getActiveSession(peerKey);
        return active?.sessionId ?? null;
    }

    /**
     * Run the session-extractor on the peer's CURRENT (active) session and
     * write the proposed skill to disk if confidence ≥ AUTO_PROMOTE_CONFIDENCE.
     * Powers the `/skills propose` slash command — lets the user capture a
     * skill from the in-flight conversation without waiting for the every-10-turn
     * automatic trigger.
     *
     * Returns the extraction result + the disk path written (or just the
     * proposal payload when confidence is below the auto-promote threshold,
     * in which case the file goes to `skills-proposed/` for human review).
     */
    async proposeSkillFromCurrentSession(rawKey: string): Promise<{
        proposed: boolean;
        reason?: string;
        name?: string;
        description?: string;
        when_to_use?: string;
        body?: string;
        confidence?: number;
        autoActivated?: boolean;
        writtenPath?: string;
    }> {
        if (!this.sessionExtractor) {
            return { proposed: false, reason: 'session extractor not configured' };
        }
        const parts = rawKey.split(':');
        if (parts.length < 3) {
            return { proposed: false, reason: 'invalid routing key' };
        }
        const [channel, scope, ...rest] = parts;
        const peerNativeId = rest.join(':');
        if (!channel || !scope || !peerNativeId) {
            return { proposed: false, reason: 'invalid routing key' };
        }
        const peerKey = `${channel}:${scope}:${peerNativeId}`;
        const active = this.store.getActiveSession(peerKey);
        if (!active) {
            return { proposed: false, reason: 'no active session for this peer' };
        }
        const threadId = `${peerKey}#${active.sessionId}`;
        try {
            const extraction = await this.runSessionExtraction(threadId, active.sessionId, peerKey);
            if (!extraction || !extraction.skill_proposal) {
                return {
                    proposed: false,
                    reason: extraction
                        ? 'no procedural pattern detected in recent conversation'
                        : 'extraction returned no result (transcript too thin or model failed)',
                };
            }
            const sp = extraction.skill_proposal;
            const autoActivated = sp.confidence >= AUTO_PROMOTE_CONFIDENCE;
            return {
                proposed: true,
                name: sp.name,
                description: sp.description,
                when_to_use: sp.when_to_use,
                body: sp.body,
                confidence: sp.confidence,
                autoActivated,
                writtenPath: autoActivated
                    ? `skills/${sp.name}/SKILL.md`
                    : `skills-proposed/${sp.name}/SKILL.md`,
            };
        } catch (err) {
            log.warn(
                { err: redactSecrets(err), peerKey, sessionId: active.sessionId },
                'proposeSkillFromCurrentSession failed',
            );
            return {
                proposed: false,
                reason: `extraction failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
            };
        }
    }

    async forceNewSession(
        rawKey: string,
    ): Promise<{ sessionId: string; summary: string | null } | undefined> {
        const parts = rawKey.split(':');
        if (parts.length < 3) return undefined;
        const [channel, scope, ...rest] = parts;
        const peerNativeId = rest.join(':');
        if (!channel || !scope || !peerNativeId) return undefined;

        let result: ReturnType<typeof this.sessionResolver.resolve>;
        try {
            result = this.sessionResolver.resolve(
                rawKey,
                { channel, scope, peerNativeId },
                { source: 'user', force: true },
            );
        } catch (err) {
            log.warn({ err: redactSecrets(err), rawKey }, 'forceNewSession failed');
            return undefined;
        }

        log.info({ rawKey, newSessionId: result.sessionId }, '/new: forced session rotation');

        if (result.previousSessionId) {
            try {
                const prevPersonality = this.store.getSessionPersonality(result.previousSessionId);
                if (prevPersonality) {
                    this.store.setSessionPersonality(result.sessionId, prevPersonality);
                    log.debug(
                        { threadId: result.threadId, personality: prevPersonality },
                        '/new: carried forward active personality',
                    );
                }
            } catch (err) {
                log.warn(
                    { err: redactSecrets(err), threadId: result.threadId },
                    '/new: personality carry-forward failed; new session starts at default',
                );
            }
        }

        if (!result.previousSessionId || !this.sessionExtractor) {
            return { sessionId: result.sessionId, summary: null };
        }

        const prevThreadId = `${result.peerId}#${result.previousSessionId}`;
        const extraction = await this.runSessionExtraction(
            prevThreadId,
            result.previousSessionId,
            result.peerId,
        ).catch((err: unknown) => {
            log.warn(
                { err: redactSecrets(err), prevThreadId },
                '/new: session extraction failed; continuing with empty summary',
            );
            return null;
        });

        // Inline prepend on next user turn — <last_session> in the system prompt is too weak.
        if (extraction?.summary) {
            this.pendingRecapPromises.set(
                result.threadId,
                Promise.resolve(extraction.summary),
            );
            log.debug(
                { threadId: result.threadId, chars: extraction.summary.length },
                '/new: recap queued for first-turn prepend',
            );
        }

        return { sessionId: result.sessionId, summary: extraction?.summary ?? null };
    }

    /**
     * Compact the peer's active session: summarise checkpoint message history
     * then replace it with a single synthetic system message. Used by `/compact`.
     */
    async compactSession(
        rawKey: string,
    ): Promise<{ messageCount: number; summary: string } | undefined> {
        const peerKey = rawKey.split('#')[0] ?? rawKey;
        const active = this.store.getActiveSession(peerKey);
        if (!active) return undefined;

        const threadId = `${peerKey}#${active.sessionId}`;

        const checkpoint = await CheckpointManager.latest<Record<string, unknown>>(
            this.checkpointer,
            threadId,
        );
        if (!checkpoint) return undefined;

        const rawMessages = checkpoint.state['messages'];
        if (!Array.isArray(rawMessages) || rawMessages.length === 0) return undefined;

        // Matches session-extractor.ts MIN_MESSAGES so /compact rarely refuses.
        const MIN_MESSAGES_FOR_COMPACT = 4;
        if (rawMessages.length < MIN_MESSAGES_FOR_COMPACT) return undefined;

        // Cap each body so very long assistant replies don't explode the summary call.
        const PER_MESSAGE_CHAR_LIMIT = 600;
        const messagesForSummary: ChatMessage[] = rawMessages
            .map((m: unknown): ChatMessage | null => {
                if (!m || typeof m !== 'object') return null;
                const msg = m as Record<string, unknown>;
                const role = msg['role'];
                if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') return null;
                const rawContent = msg['content'];
                let body = '';
                if (typeof rawContent === 'string') body = rawContent;
                else if (Array.isArray(rawContent)) {
                    body = rawContent
                        .filter((b): b is { type: 'text'; text: string } =>
                            !!b && typeof b === 'object' &&
                            (b as Record<string, unknown>)['type'] === 'text' &&
                            typeof (b as Record<string, unknown>)['text'] === 'string',
                        )
                        .map((b) => b.text)
                        .join('');
                }
                if (!body) return null;
                return { role, content: body.slice(0, PER_MESSAGE_CHAR_LIMIT) };
            })
            .filter((m): m is ChatMessage => m !== null);

        if (messagesForSummary.length === 0) return undefined;

        let summary: string;
        try {
            summary = await summarizeForCompaction(this.config.model, messagesForSummary);
        } catch (err) {
            log.warn({ err: redactSecrets(err), threadId }, '/compact: LLM summarisation failed');
            return undefined;
        }

        if (!summary) return undefined;

        const summaryMessage = {
            role: 'system',
            content: `[Session compacted — ${rawMessages.length} earlier messages summarised]\n\n${summary}`,
        };
        const compactedState: Record<string, unknown> = {
            ...checkpoint.state,
            messages: [summaryMessage],
        };

        await this.checkpointer.save({
            ...checkpoint,
            checkpointId: `${threadId}:compact:${Date.now()}`,
            state: compactedState,
            savedAt: Date.now(),
            metadata: {
                ...(checkpoint.metadata ?? {}),
                compactedAt: Date.now(),
                compactedMessageCount: rawMessages.length,
            },
        });

        // Evict so next invoke reloads from the new checkpoint.
        this.evictPeerThreads(peerKey);

        log.info(
            { threadId, messageCount: rawMessages.length, summaryChars: summary.length },
            '/compact: session compacted',
        );

        return { messageCount: rawMessages.length, summary };
    }

    // Clears every matching thread — after /new it's the OLD thread the user wants cleared.
    cancelPlan(rawKey: string): boolean {
        let cleared = false;
        for (const [threadId] of this.threads) {
            if (!isThreadForRawKey(threadId, rawKey)) continue;
            if (clearPlanForThread(threadId)) cleared = true;
        }
        return cleared;
    }

    listMcpServers(): ReadonlyArray<{
        name: string;
        status: 'connected' | 'skipped' | 'failed' | 'disabled';
        reason?: string;
        toolCount?: number;
    }> {
        return this.mcp.listServers().map((s) => ({ ...s }));
    }

    // Without evictCachedThreads, existing conversations keep their stale boot-time tool list.
    async reloadMcp(opts?: { evictCachedThreads?: boolean }): Promise<{
        connected: string[];
        skipped: Array<{ name: string; reason: string }>;
        failed: Array<{ name: string; reason: string }>;
        evictedCachedThreads: boolean;
    }> {
        const result = await this.mcp.reload();

        let evictedCachedThreads = false;
        if (opts?.evictCachedThreads && result.connected.length > 0) {
            const victimIds = [...this.threads.keys()];
            await Promise.allSettled(
                victimIds.map(async (id) => {
                    const entry = this.threads.get(id);
                    if (!entry) return;
                    await entry.entry.sandboxSession?.close().catch(() => undefined);
                    this.threads.delete(id);
                }),
            );
            evictedCachedThreads = true;
        }

        return { ...result, evictedCachedThreads };
    }

    async branchSession(
        rawKey: string,
        label: string,
    ): Promise<
        | { ok: true; sessionId: string; label: string }
        | { ok: false; reason: 'no-active-session' | 'duplicate' | 'invalid-label' | 'failed' }
    > {
        const trimmed = label.trim();
        if (trimmed.length === 0) return { ok: false, reason: 'invalid-label' };

        const peerKey = rawKey.split('#')[0] ?? rawKey;
        const active = this.store.getActiveSession(peerKey);
        if (!active) return { ok: false, reason: 'no-active-session' };

        const srcThreadId = `${peerKey}#${active.sessionId}`;
        try {
            const newRow = this.store.forkSession({
                peerId: peerKey,
                srcSessionId: active.sessionId,
                srcThreadId,
                newThreadId: (newSessionId) => `${peerKey}#${newSessionId}`,
                label: trimmed,
                source: 'user',
            });

            const newThreadId = `${peerKey}#${newRow.sessionId}`;

            // Working memory lives in the checkpoint store (messages table is FTS-only).
            try {
                await CheckpointManager.fork(this.checkpointer, {
                    sourceThreadId: srcThreadId,
                    newThreadId,
                    metadata: { branchLabel: trimmed },
                });
            } catch (err) {
                if (err instanceof Error && err.message.includes('no checkpoints')) {
                    log.debug(
                        { srcThreadId, newThreadId },
                        '/branch: source thread has no checkpoints to clone — new branch starts empty',
                    );
                } else {
                    throw err;
                }
            }

            this.evictPeerThreads(peerKey);

            log.info(
                { peerId: peerKey, newSessionId: newRow.sessionId, label: trimmed },
                '/branch: forked session + cloned checkpoint state',
            );
            return { ok: true, sessionId: newRow.sessionId, label: trimmed };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('UNIQUE constraint failed')) {
                return { ok: false, reason: 'duplicate' };
            }
            log.warn({ rawKey, err: redactSecrets(err) }, 'branchSession failed');
            return { ok: false, reason: 'failed' };
        }
    }

    async switchBranch(
        rawKey: string,
        label: string,
    ): Promise<
        | { ok: true; sessionId: string; label: string }
        | { ok: false; reason: 'unknown-label' | 'invalid-label' }
    > {
        const trimmed = label.trim();
        if (trimmed.length === 0) return { ok: false, reason: 'invalid-label' };

        const peerKey = rawKey.split('#')[0] ?? rawKey;
        const target = this.store.switchToBranch(peerKey, trimmed);
        if (!target) return { ok: false, reason: 'unknown-label' };

        this.evictPeerThreads(peerKey);
        log.info(
            { peerId: peerKey, sessionId: target.sessionId, label: trimmed },
            '/branch: switched to branch',
        );
        return { ok: true, sessionId: target.sessionId, label: trimmed };
    }

    listBranches(rawKey: string): SessionRow[] {
        const peerKey = rawKey.split('#')[0] ?? rawKey;
        return this.store.listBranchesForPeer(peerKey);
    }

    private evictPeerThreads(peerKey: string): void {
        this.threads.evictPeerThreads(peerKey);
    }

    private runSessionExtraction(
        closedThreadId: string,
        closedSessionId: string,
        peerId: string,
    ): Promise<ExtractionResult | null> {
        return runExtractionViaModule(
            { closedThreadId, closedSessionId, peerId },
            {
                ...(this.sessionExtractor ? { sessionExtractor: this.sessionExtractor } : {}),
                store: this.store,
                memoryConfig: this.config.memory,
                getMemoryProvider: () => this.getMemoryProvider(),
                checkpointer: this.checkpointer,
            },
        );
    }

    private async getOrCreateThread(
        threadId: string,
        opts: {
            isProactive?: boolean;
            deliveryMode?: 'always' | 'conditional' | 'silent';
        } = {},
    ): Promise<ThreadEntry> {
        const existing = this.threads.get(threadId);
        if (existing) return existing;

        const identity = await this.config.resolveThread(threadId);

        const allMcpTools = await this.mcp.getReadyTools();
        const filteredMcpTools = this.mcp.filterForAgent(
            allMcpTools,
            this.entryDef.name,
            this.entryDef.mcpServers,
        );
        const { staticMcpTools, dynamicMcpTools } = this.mcp.partitionByPreload(filteredMcpTools);
        const mcpTools = dynamicMcpTools as unknown as BaseTool[];
        const mcpPreloadedTools = staticMcpTools as unknown as BaseTool[];

        const memoryCharLimits: Record<string, number> = (() => {
            const memCfg = this.config.memory ?? {};
            const memLim = memCfg.memoryCharLimit ?? 2200;
            const usrLim = memCfg.userCharLimit ?? 1375;
            return { user: usrLim, memory: memLim };
        })();

        const memoryStore = await this.getMemoryProvider(identity.userId);

        const member = createTeamMember(this.entryDef, {
            model: this.config.model,
            userId: identity.userId,
            userName: identity.userName,
            store: this.store,
            memoryCharLimits,
            ...(memoryStore ? { memoryStore } : {}),
            extraInterceptors: [this.tokens, ...(await this.buildMemoryPlugins())],
            checkpointer: this.checkpointer,
            extraTools: mcpPreloadedTools.length > 0 ? mcpPreloadedTools : undefined,
            extraDynamicTools: mcpTools,
            teamRoster: this.buildTeamRoster(),
            mainAgentName: this.entryDef.name,
            personalities: this.personalities,
            // 180s tolerates Ollama cold-start (large models take 30-60s to load).
            modelCallTimeoutMs: 180_000,
            // outputSchema gated on deliveryMode: conditional only (always/silent emit prose).
            ...(opts.isProactive
                ? {
                    isProactive: true,
                    ...(opts.deliveryMode === 'conditional'
                        ? { outputSchema: ProactiveDecisionSchema }
                        : {}),
                }
                : {}),
            ...(this.config.observability ? { observability: this.config.observability } : {}),
        });

        const registry = new TaskRegistry();
        const buildSubAgent = this.makeSubAgentFactory(identity, threadId, registry);

        const entry: ThreadEntry = {
            entry: member,
            identity,
            registry,
            buildSubAgent,
            lastUsedAt: Date.now(),
            activeTurns: 0,
            turnNumber: 0,
            accumulatedMessages: [],
        };

        this.threads.set(threadId, entry);
        this.evictIfAtCapacity();
        void fanoutFireSessionStart(entry.entry.interceptors, threadId);

        log.info(
            {
                threadId,
                userId: identity.userId,
                agent: member.name,
                domain: member.domain,
                workers: this.allowedWorkers.map((w) => w.name),
            },
            'thread member instantiated',
        );

        return entry;
    }

    private makeSubAgentFactory(identity: ThreadIdentity, threadId: string, registry: TaskRegistry): SubAgentFactory {
        return (workerName: string): SubAgentRunner | undefined => {
            const def = this.allowedWorkers.find((w) => w.name === workerName);
            if (!def) return undefined;

            return async ({ task, signal, depth, spawnChain }) => {
                const allMcpTools = await this.mcp.getReadyTools();
                const filteredWorkerMcp = this.mcp.filterForAgent(
                    allMcpTools,
                    def.name,
                    def.mcpServers,
                );
                const { staticMcpTools: workerStaticMcp, dynamicMcpTools: workerDynamicMcp } =
                    this.mcp.partitionByPreload(filteredWorkerMcp);
                const workerMcpTools = workerDynamicMcp as unknown as BaseTool[];
                const workerPreloadedMcp = workerStaticMcp as unknown as BaseTool[];

                const workerModel = await resolveWorkerModel(def, this.config.model);

                // Catches "disabled in flopsy.json5 but still delegated" before a doomed run.
                const rosterMcpNames = this.mcp.serversForWorker(def);
                if (rosterMcpNames.length > 0 && workerMcpTools.length === 0) {
                    log.warn(
                        {
                            worker: def.name,
                            expectedMcp: rosterMcpNames,
                            bridgedCount: 0,
                        },
                        'worker dispatched with 0 bridged MCP tools — check that MCP servers are enabled and connected',
                    );
                }

                // Deterministic child threadId so a restarted gateway can resume mid-flight.
                const childThreadId = `${threadId}:worker:${def.name}:${stableHash(task)}`;

                const peerRoster = this.buildTeamRoster().filter((m) => m.name !== def.name);
                const workerMemoryStore = await this.getMemoryProvider(identity.userId);
                const worker = createTeamMember(def, {
                    model: workerModel,
                    userId: identity.userId,
                    userName: identity.userName,
                    store: this.store,
                    ...(workerMemoryStore ? { memoryStore: workerMemoryStore } : {}),
                    extraInterceptors: [this.tokens, ...(await this.buildMemoryPlugins())],
                    extraTools: workerPreloadedMcp.length > 0 ? workerPreloadedMcp : undefined,
                    extraDynamicTools: workerMcpTools,
                    modelCallTimeoutMs: 180_000,
                    checkpointer: this.checkpointer,
                    teamRoster: peerRoster,
                    mainAgentName: this.entryDef.name,
                    ...(this.config.observability ? { observability: this.config.observability } : {}),
                });

                try {
                    const startedAt = Date.now();
                    const taskPreview = task.length > 120 ? task.slice(0, 117) + '…' : task;
                    log.debug(
                        { worker: workerName, depth, threadId: childThreadId, taskPreview },
                        'sub-agent starting',
                    );
                    const parentBrief = await buildParentBrief(this.checkpointer, threadId, 5);
                    const queued = registry.drainTeammateMessages(def.name);
                    const initialMessages: ChatMessage[] = [];
                    for (const msg of queued) {
                        initialMessages.push({ role: 'system', content: msg });
                    }
                    initialMessages.push({ role: 'user', content: task });

                    let result;
                    try {
                        result = await worker.agent.invoke(
                            { messages: initialMessages },
                            {
                                signal,
                                threadId: childThreadId,
                                configurable: {
                                    userId: identity.userId,
                                    threadId: childThreadId,
                                    parentThreadId: threadId,
                                    depth: depth ?? 1,
                                    spawnChain: spawnChain ?? [],
                                    registry,
                                    agentName: def.name,
                                    runStore: this.store,
                                    ...(parentBrief ? { parentBrief } : {}),
                                },
                            },
                        );
                    } catch (invokeErr) {
                        // Best-effort partial-result capture: the executor saves
                        // a checkpoint after every node transition, so by the
                        // time invoke() throws (timeout, abort, network), the
                        // latest checkpoint usually holds the worker's most
                        // recent assistant message. Surface it as a
                        // PartialResultError — spawn's catch block reads
                        // `.partialResult` and forwards it on task_error, so
                        // the parent agent sees what was achieved before the
                        // failure instead of just an opaque error string.
                        const partial = await extractCheckpointPartialResult(
                            this.checkpointer,
                            childThreadId,
                        );
                        throw new PartialResultError(invokeErr, partial);
                    }

                    const messages =
                        (result.messages as unknown as Array<{
                            role: string;
                            content: unknown;
                        }>) ?? [];
                    const lastAssistant = [...messages]
                        .reverse()
                        .find((m) => m.role === 'assistant');
                    if (!lastAssistant) return '';
                    const fullReply = typeof lastAssistant.content === 'string'
                        ? lastAssistant.content
                        : JSON.stringify(lastAssistant.content);
                    const reply = await this.foldWorkerReply(
                        fullReply,
                        workerName,
                        task,
                    );
                    log.debug(
                        { worker: workerName, depth, durationMs: Date.now() - startedAt, replyLength: reply.length },
                        'sub-agent completed',
                    );
                    return reply;
                } finally {
                    await worker.harnessInterceptor?.flush().catch((err: unknown) => {
                        log.warn(
                            { err: redactSecrets(err), threadId, worker: workerName, op: 'harness.flush' },
                            'worker harness flush failed — learning signals from this run may be lost',
                        );
                    });
                }
            };
        };
    }

    private buildTeamRoster(): readonly TeamRosterEntry[] {
        return this.allowedWorkers.map((def): TeamRosterEntry => ({
            name: def.name,
            type: def.type,
            ...(def.domain !== undefined ? { domain: def.domain } : {}),
            ...(def.whenToUse !== undefined ? { whenToUse: def.whenToUse } : {}),
            toolsets: def.toolsets ?? [],
            mcpServers: this.mcp.serversForWorker(def),
        }));
    }

    private async foldWorkerReply(
        fullReply: string,
        workerName: string,
        task: string,
    ): Promise<string> {
        if (!fullReply || fullReply.length < WORKER_REPLY_OFFLOAD_THRESHOLD_CHARS) {
            return fullReply;
        }

        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = workspace.work('worker-outputs');
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err), dir },
                'foldWorkerReply: mkdir failed, falling back to inline truncation',
            );
            return (
                fullReply.slice(0, WORKER_REPLY_PREVIEW_CHARS) +
                `\n\n[truncated — full reply was ${fullReply.length} chars; could not offload to disk]`
            );
        }

        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const slug = task
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'task';
        const fileName = `${workerName}__${slug}__${ts}.md`;
        const fullPath = path.join(dir, fileName);

        try {
            fs.writeFileSync(fullPath, fullReply, 'utf-8');
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err), fullPath },
                'foldWorkerReply: write failed, falling back to inline truncation',
            );
            return (
                fullReply.slice(0, WORKER_REPLY_PREVIEW_CHARS) +
                `\n\n[truncated — full reply was ${fullReply.length} chars; could not offload to disk]`
            );
        }

        // Absolute path so read_file (resolves against process.cwd) finds it regardless of launch dir.
        const absPath = fullPath;

        return [
            `[handoff: ${workerName} → orchestrator]`,
            `Reply size: ${fullReply.length.toLocaleString()} chars (${(fullReply.length / 1024).toFixed(1)} KB)`,
            `Full reply saved to: ${absPath}`,
            `Use read_file("${absPath}") to load the rest if you need more than the preview below.`,
            '',
            '--- preview ---',
            fullReply.slice(0, WORKER_REPLY_PREVIEW_CHARS),
            '--- end preview ---',
        ].join('\n');
    }


    private get allowedWorkers(): ReadonlyArray<AgentDefinition> {
        if (this._allowedWorkersCache) return this._allowedWorkersCache;
        const explicit = this.entryDef.workers;
        const all = this.config.team.filter(
            (a) => a.enabled && resolveRole(a) === 'worker',
        );
        const selected = explicit
            ? all.filter((a) => explicit.includes(a.name))
            : all;
        this._allowedWorkersCache = selected;
        return selected;
    }
    private _allowedWorkersCache?: ReadonlyArray<AgentDefinition>;

    private evictIfAtCapacity(): void {
        this.threads.evictIfAtCapacity();
    }
}

async function resolveWorkerModel(
    def: AgentDefinition,
    fallback: BaseChatModel,
): Promise<BaseChatModel> {
    if (!def.model) return fallback;
    try {
        const ref = parseModelString(def.model);
        return await ModelLoader.getInstance().from({
            provider: ref.provider as Provider,
            name: ref.name,
        });
    } catch (err) {
        log.warn(
            {
                agent: def.name,
                model: def.model,
                err: err instanceof Error ? err.message : String(err),
            },
            'worker model load failed — inheriting main agent model',
        );
        return fallback;
    }
}

function isThreadForRawKey(threadId: string, rawKey: string): boolean {
    return threadId === rawKey || threadId.startsWith(rawKey + '#');
}

// FNV-1a 32-bit; deterministic across restarts.
function stableHash(input: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

async function buildParentBrief(
    checkpointer: CheckpointStore,
    threadId: string,
    limit = 5,
): Promise<string | undefined> {
    try {
        const raw = await checkpointer.getThreadMessages<
            { role?: string; content?: unknown; toolCalls?: unknown[] }
        >(threadId, { limit: limit * 2 }); // fetch extra to account for tool-result filtering
        if (!raw || raw.length === 0) return undefined;

        const turns = raw
            .filter((m) => {
                if (m.role !== 'user' && m.role !== 'assistant') return false;
                if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) return false;
                return true;
            })
            .slice(-limit);

        if (turns.length === 0) return undefined;

        const lines = turns.map((m) => {
            const text = extractMessageText(m.content).slice(0, 300);
            const label = m.role === 'user' ? 'User' : 'Gandalf';
            return `  [${label}] ${text}`;
        });

        return `<parent_context>\nRecent conversation (last ${turns.length} turn${turns.length === 1 ? '' : 's'}):\n${lines.join('\n')}\n</parent_context>`;
    } catch {
        return undefined; // best-effort; never break delegation on brief failure
    }
}

function extractMessageText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((b): b is { type: string; text: string } =>
                b != null && typeof b === 'object' && 'type' in b && (b as Record<string, unknown>).type === 'text' && 'text' in b,
            )
            .map((b) => b.text)
            .join('');
    }
    return '';
}

/**
 * Pull the last assistant text from the most recent checkpoint for a
 * thread — used by makeSubAgentFactory to recover partial work when the
 * sub-agent's `invoke()` throws (timeout, abort, network). Best-effort:
 * any failure here returns `undefined` so the outer flow falls back to
 * an error-only `task_error` event.
 *
 * Mirrors claude-code's `extractPartialResult` (agentToolUtils.ts:488-500)
 * but reads from the checkpoint store rather than an in-memory message
 * array — flopsygraph doesn't expose mid-flight messages to the caller,
 * so the checkpoint is the only surface that has them.
 */
async function extractCheckpointPartialResult(
    checkpointer: CheckpointStore,
    threadId: string,
): Promise<string | undefined> {
    try {
        const checkpoints = await checkpointer.listByThread<{
            messages?: Array<{ role: string; content: unknown }>;
        }>(threadId);
        const latest = checkpoints[0];
        if (!latest) return undefined;
        const messages = latest.state.messages;
        if (!Array.isArray(messages) || messages.length === 0) return undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!m || m.role !== 'assistant') continue;
            const text = extractMessageText(m.content).trim();
            if (text.length > 0) return text;
        }
        return undefined;
    } catch (err) {
        log.warn(
            { err: redactSecrets(err), threadId },
            'partial-result extraction from checkpoint failed — proceeding with error-only event',
        );
        return undefined;
    }
}

const WORKER_REPLY_OFFLOAD_THRESHOLD_CHARS = 1500;
const WORKER_REPLY_PREVIEW_CHARS = 800;

function localDateString(d: Date = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function buildContent(
    text: string,
    media?: ReadonlyArray<InboundMedia>,
): string | ContentBlock[] {
    if (!media?.length) return text;

    const imageBlocks: ContentBlock[] = [];
    const fallbackLines: string[] = [];
    const documentBlocks: string[] = [];

    for (const m of media) {
        if (m.type === 'image') {
            if (m.data) {
                imageBlocks.push({ type: 'image', mediaType: m.mimeType ?? 'image/jpeg', data: m.data });
            } else if (m.url) {
                imageBlocks.push({ type: 'image_url', url: m.url });
            } else {
                fallbackLines.push('[Image: content unavailable]');
            }
        } else if (m.type === 'document' && typeof m.text === 'string') {
            const label = m.fileName ?? m.mimeType ?? 'attached file';
            const fence = m.fileName?.split('.').pop()?.toLowerCase() ?? '';
            documentBlocks.push(`\n[file: ${label}]\n\`\`\`${fence}\n${m.text}\n\`\`\``);
        } else if (m.type === 'document') {
            const label = m.fileName ?? m.mimeType ?? 'file';
            const sizeNote = m.url ? ` at ${m.url}` : '';
            fallbackLines.push(`[Document not inlined: ${label}${sizeNote}]`);
        }
    }

    let bodyText = text;
    if (documentBlocks.length > 0) {
        bodyText = `${bodyText}${documentBlocks.join('')}`.trim();
    }
    if (fallbackLines.length > 0) {
        bodyText = `${bodyText}\n${fallbackLines.join('\n')}`.trim();
    }

    if (imageBlocks.length === 0) return bodyText;

    return [...imageBlocks, { type: 'text', text: bodyText }];
}

function staticConfigFields(def: AgentDefinition): Partial<import('@flopsy/gateway').TeamMemberStatus> {
    const sb = (def as AgentDefinition & { sandbox?: Record<string, unknown> }).sandbox;
    const sandbox = sb && sb['enabled'] === true
        ? {
              enabled: true as const,
              ...(typeof sb['backend'] === 'string' ? { backend: sb['backend'] as string } : {}),
              ...(typeof sb['language'] === 'string' ? { language: sb['language'] as string } : {}),
              ...(typeof sb['programmaticToolCalling'] === 'boolean'
                  ? { programmaticToolCalling: sb['programmaticToolCalling'] as boolean }
                  : {}),
          }
        : undefined;
    return {
        ...(def.role ? { role: def.role } : {}),
        ...(def.domain ? { domain: def.domain } : {}),
        ...(def.model ? { model: def.model } : {}),
        ...(def.toolsets && def.toolsets.length > 0 ? { toolsets: def.toolsets } : {}),
        ...(def.mcpServers && def.mcpServers.length > 0 ? { mcpServers: def.mcpServers } : {}),
        ...(sandbox ? { sandbox } : {}),
    };
}


