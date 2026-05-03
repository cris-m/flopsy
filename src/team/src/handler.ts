import { createLogger, resolveWorkspacePath, scrubPii } from '@flopsy/shared';
import type {
    AgentCallbacks,
    AgentChunk,
    AgentHandler,
    AgentResult,
    AggregateTaskSummary,
    InboundMedia,
    InvokeRole,
    TaskListFilter,
    TaskStatusSummary,
    ThreadStatusSnapshot,
} from '@flopsy/gateway';
import type { AgentDefinition, McpConfig } from '@flopsy/shared';
import type { BaseChatModel, BaseStore, CheckpointStore, BaseTool, Provider, ContentBlock, ModelRouter, TextBlock } from 'flopsygraph';
import {
    CheckpointManager,
    ModelLoader,
    OllamaEmbedder,
    SqliteCheckpointStore,
    SqliteMemoryStore,
    tokenCounter,
} from 'flopsygraph';

import { parseModelString } from './bootstrap';
import { createTeamMember, resolveRole } from './factory';
import type { TeamMember, TeamRosterEntry } from './factory';
import { getSharedLearningStore, getSharedPairingStore } from './harness';
import { setPairingFacade, setPersonalityFacade, setInsightsFacade, setBranchFacade } from '@flopsy/gateway';
import type { SessionExtractor, ExtractionResult, SkillProposal } from './harness/review';
import {
    scanExistingSkills,
    writeSkillFile,
    appendLessonsToSkill,
} from './harness/review';
import { join as pathJoin } from 'path';
import type { PersonalityRegistry } from './personalities';
import {
    McpClientManager,
    bridgeAllTools,
    filterToolsForAgent,
    loadMcpServers,
    type BridgedTool,
} from './mcp';
import type { LearningStore, SessionRow } from './harness';
import { SessionResolver } from './session-resolver';
import { TaskRegistry } from './state/task-registry';
import type {
    SubAgentFactory,
    SubAgentRunner,
} from './tools/spawn-background-task';

const log = createLogger('team-handler');

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
        readonly embedder?: {
            readonly provider?: 'ollama';
            readonly model?: string;
            readonly baseUrl?: string;
        };
    };

    readonly mcp?: McpConfig;
    readonly sessionExtractor?: SessionExtractor;
    readonly modelRouter?: ModelRouter;
    readonly modelRouters?: ReadonlyMap<string, ModelRouter>;
    readonly personalities?: PersonalityRegistry;
    readonly observability?: import('flopsygraph').Observability;
}

interface ThreadEntry {
    readonly entry: TeamMember;
    readonly identity: ThreadIdentity;
    readonly registry: TaskRegistry;
    readonly buildSubAgent: SubAgentFactory;
    lastUsedAt: number;
    activeTurns: number;
}

export class TeamHandler implements AgentHandler {
    private readonly config: TeamHandlerConfig;
    private readonly maxThreads: number;
    private readonly store: LearningStore;
    private readonly sessionResolver!: SessionResolver;
    private readonly threads = new Map<string, ThreadEntry>();
    private readonly entryDef: AgentDefinition;
    private readonly tokens: ReturnType<typeof tokenCounter>;
    // Kept off state.db: gzipped checkpoint blobs would thrash the learning-store WAL.
    private readonly checkpointer: CheckpointStore;
    private readonly memoryStore: BaseStore;
    private readonly mcpManager: McpClientManager;
    private readonly mcpAssignToMap: Readonly<Record<string, readonly string[]>>;
    private readonly mcpServersCfg: McpConfig['servers'];
    private mcpReady: Promise<readonly BridgedTool[]> = Promise.resolve([]);
    private mcpSkipReasons: Readonly<Record<string, string>> = {};
    private readonly mcpToolCounts = new Map<string, number>();
    private readonly sessionExtractor?: SessionExtractor;
    readonly modelRouter?: ModelRouter;
    readonly modelRouters?: ReadonlyMap<string, ModelRouter>;
    readonly personalities?: PersonalityRegistry;
    private readonly pendingRecapPromises = new Map<string, Promise<string | null>>();

    constructor(config: TeamHandlerConfig) {
        this.config = config;
        this.maxThreads = config.maxThreads ?? 100;
        this.store = config.store ?? getSharedLearningStore();
        this.sessionExtractor = config.sessionExtractor;
        this.modelRouter = config.modelRouter;
        this.modelRouters = config.modelRouters;
        this.personalities = config.personalities;

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
            setPersonalityFacade({
                list: () =>
                    personalities.list().map((p) => ({
                        name: p.name,
                        description: p.description,
                    })),
                getActive: (rawKey) => {
                    const sessionId = this.resolveActiveSessionId(rawKey);
                    return sessionId ? this.store.getSessionPersonality(sessionId) : null;
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
            keepLatestPerThread: 30,
        });

        const memoryCfg = config.memory ?? {};
        const memoryEnabled = memoryCfg.enabled !== false;
        const embedderCfg = memoryCfg.embedder;
        const embedder =
            memoryEnabled && embedderCfg?.model
                ? new OllamaEmbedder(
                      embedderCfg.model,
                      {},
                      undefined,
                      embedderCfg.baseUrl,
                  )
                : undefined;
        this.memoryStore = new SqliteMemoryStore({
            path: resolveWorkspacePath('state', 'memory.db'),
            ...(embedder ? { embedder } : {}),
        });
        log.info(
            {
                memoryPath: resolveWorkspacePath('state', 'memory.db'),
                memoryEnabled,
                embedderModel: embedderCfg?.model ?? 'none',
                embedderBaseUrl: embedderCfg?.baseUrl ?? 'default',
            },
            'memoryStore ready',
        );
        this.tokens = tokenCounter({
            keyFn: (ctx) =>
                (ctx.configurable as { threadId?: string })?.threadId ?? ctx.threadId,
            persistAcrossGraphEnd: true,
            onUpdate: (threadId, delta, _cumulative, ctx, response) => {
                const date = localDateString();
                // modelFallback pins _fallbackTo on response.raw to keep token attribution accurate.
                const fallback = (response.raw as Record<string, unknown> | undefined)?.['_fallbackTo'] as
                    { provider?: string; model?: string } | undefined;
                this.store.recordTokenUsage({
                    threadId,
                    date,
                    provider: fallback?.provider ?? ctx.provider,
                    model:    fallback?.model    ?? ctx.model,
                    input:  delta.input,
                    output: delta.output,
                });
            },
        });

        const mcpManager = new McpClientManager();
        this.mcpManager = mcpManager;
        this.mcpServersCfg = config.mcp?.servers ?? {};
        const mcpServersCfg = this.mcpServersCfg;
        this.mcpAssignToMap = Object.fromEntries(
            Object.entries(mcpServersCfg)
                .filter(([, srv]) => srv.enabled !== false)
                .map(([name, srv]) => [name, srv.assignTo ?? []]),
        );
        const mcpEnabled = config.mcp?.enabled !== false;
        if (mcpEnabled && Object.keys(mcpServersCfg).length > 0) {
            this.mcpReady = (async () => {
                try {
                    const { servers, skipped } = await loadMcpServers(mcpServersCfg);
                    this.mcpSkipReasons = { ...skipped };
                    Object.entries(skipped).forEach(([name, reason]) =>
                        log.info({ server: name, reason }, 'mcp server skipped'),
                    );
                    if (servers.length === 0) return [];
                    await mcpManager.connect(servers);
                    const bridged = await bridgeAllTools(mcpManager);
                    this.mcpToolCounts.clear();
                    for (const t of bridged) {
                        this.mcpToolCounts.set(t.mcpServer, (this.mcpToolCounts.get(t.mcpServer) ?? 0) + 1);
                    }
                    return bridged;
                } catch (err) {
                    log.error(
                        { err: redactSecrets(err) },
                        'mcp connect/bridge failed — agents will run without MCP tools',
                    );
                    return [];
                }
            })();
        }

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
        });
        entry.lastUsedAt = Date.now();

        entry.activeTurns += 1;
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
                channelName: callbacks.channelName,
                channelCapabilities: callbacks.channelCapabilities,
                peer: callbacks.peer,
                sender: callbacks.sender,
                messageId: callbacks.messageId,
                personality: callbacks.personality,
                runtimeHints: callbacks.runtimeHints,
                taskStore: this.store,
                onAuthSuccess: async (provider: string) => {
                    if (!this.mcpServersCfg || Object.keys(this.mcpServersCfg).length === 0) return;
                    let affected: string[] = [];
                    try {
                        affected = Object.entries(this.mcpServersCfg)
                            .filter(([, srv]) =>
                                srv.enabled !== false &&
                                srv.requiresAuth?.includes(provider),
                            )
                            .map(([name]) => name);
                        if (affected.length === 0) return;
                        log.info({ provider, servers: affected }, 'reloading mcp servers after auth');
                        const { servers } = await loadMcpServers(
                            Object.fromEntries(
                                affected.map((n) => [n, this.mcpServersCfg[n]!]),
                            ),
                        );
                        if (servers.length > 0) await this.mcpManager.restartServers(servers);
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
                },
            };

            // Persist BEFORE invoke so the user turn survives an agent crash mid-turn.
            if (role === 'user') {
                try {
                    this.store.recordMessage({
                        userId: entry.identity.userId,
                        threadId,
                        role: 'user',
                        content: text,
                    });
                } catch (err) {
                    log.warn(
                        { threadId, err: redactSecrets(err), op: 'recordMessage.user' },
                        'failed to persist user turn — session search may miss this message',
                    );
                }
            }

            const effectiveText = awayRecap
                ? `[Continuity context — recap of your last session with this user: ${awayRecap}]\n[How to use this: if the user opens with a casual greeting like "hey", "how is everything", "what's up" — DO NOT reply with a generic "How can I help today?". Reference the recap: name what was in flight and ask if they want to continue, or proactively check the next step. If the user asks a direct question, answer it AND, if the recap mentions a pending follow-up, mention it briefly. Only ignore the recap if it's plainly irrelevant to what they just said.]\n\n${text}`
                : text;
            const content = buildContent(effectiveText, media);

            type FlopsyStreamChunk = {
                content?: string;
                reasoning?: string;
                toolCallDeltas?: Array<{ index: number; id?: string; name?: string; args?: string }>;
            };
            type ChunkEvent = { type: 'message-chunk'; chunk?: FlopsyStreamChunk };
            type NodeEvent = { type: 'node-start' | 'node-finish'; node: string; updates?: Record<string, unknown> };
            type ResultEvent = { type: 'result'; data?: { state?: unknown } };
            type AgentStreamEvent = ChunkEvent | NodeEvent | ResultEvent | { type: string };

            // Tool-call deltas arrive in two parts: the start has name+index, later deltas
            // carry partial_json args fragments — accumulate args by index for the tool-start emit.
            let lastToolName: string | undefined;
            let lastToolIndex: number | undefined;
            const toolArgsByIndex = new Map<number, string>();
            let resultState: unknown = null;

            const emit = (chunk: AgentChunk): void => {
                if (!callbacks.onChunk) return;
                try { callbacks.onChunk(chunk); } catch { /* preview path is best-effort */ }
            };

            const stream = (entry.entry.agent as unknown as {
                stream: (
                    input: { messages: Array<{ role: string; content: unknown }> },
                    opts: { threadId: string; signal: AbortSignal; configurable: Record<string, unknown> },
                ) => AsyncIterable<AgentStreamEvent>;
            }).stream(
                { messages: [{ role, content }] },
                { threadId, signal: callbacks.signal, configurable },
            );

            for await (const event of stream) {
                if (event.type === 'message-chunk') {
                    const c = (event as ChunkEvent).chunk;
                    if (!c) continue;
                    if (c.content) emit({ type: 'text_delta', text: c.content });
                    if (c.reasoning) emit({ type: 'thinking', text: c.reasoning });
                    if (c.toolCallDeltas) {
                        for (const d of c.toolCallDeltas) {
                            if (d.name) {
                                lastToolName = d.name;
                                lastToolIndex = d.index;
                            }
                            if (d.args !== undefined) {
                                const prev = toolArgsByIndex.get(d.index) ?? '';
                                toolArgsByIndex.set(d.index, prev + d.args);
                            }
                        }
                    }
                } else if (event.type === 'node-start') {
                    if ((event as NodeEvent).node === 'tools' && lastToolName) {
                        const args = lastToolIndex !== undefined
                            ? toolArgsByIndex.get(lastToolIndex)
                            : undefined;
                        emit({ type: 'tool_start', toolName: lastToolName, ...(args ? { args } : {}) });
                    }
                } else if (event.type === 'node-finish') {
                    if ((event as NodeEvent).node === 'tools' && lastToolName) {
                        emit({ type: 'tool_result', toolName: lastToolName });
                        if (lastToolIndex !== undefined) toolArgsByIndex.delete(lastToolIndex);
                        lastToolName = undefined;
                        lastToolIndex = undefined;
                    }
                } else if (event.type === 'result') {
                    resultState = (event as ResultEvent).data?.state;
                }
            }

            if (!resultState) {
                throw new Error('agent stream completed without a result event');
            }
            const result = resultState as {
                messages?: unknown;
                tokenUsage?: unknown;
                stoppedByLimit?: unknown;
                toolStepCount?: unknown;
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

            const usage = result.tokenUsage as unknown as
                | { promptTokens: number; completionTokens: number }
                | undefined;

            if (reply && reply.trim().length > 0) {
                try {
                    this.store.recordMessage({
                        userId: entry.identity.userId,
                        threadId,
                        role: 'assistant',
                        content: reply,
                    });
                } catch (err) {
                    log.warn(
                        { threadId, err: redactSecrets(err), op: 'recordMessage.assistant' },
                        'failed to persist assistant reply — session search may miss this message',
                    );
                }
            }

            if (role === 'user') {
                const peerId = threadId.split('#')[0] ?? threadId;
                try {
                    this.sessionResolver.touch(peerId, 'user');
                } catch (err) {
                    log.warn(
                        { threadId, err: redactSecrets(err), op: 'session.touch' },
                        'failed to touch session — turn_count + freshness may drift',
                    );
                }
            }

            return {
                reply,
                didSendViaTool: false,
                tokenUsage: usage
                    ? { input: usage.promptTokens, output: usage.completionTokens }
                    : undefined,
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
        }
    }

    get activeThreadCount(): number {
        return this.threads.size;
    }

    queryStatus(threadId: string): ThreadStatusSnapshot | undefined {
        const entry = this.threads.get(threadId);

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

            return {
                threadId,
                entryAgent: this.entryDef.name,
                activeTasks: [],
                recentTasks: [],
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
        const entries = [...this.threads.values()];
        this.threads.clear();
        await Promise.allSettled(
            entries.map((e) => e.entry.harnessInterceptor?.flush() ?? Promise.resolve()),
        );
        // WAL checkpoint on shutdown — otherwise the next boot replays it.
        const closable = this.checkpointer as { close?: () => void | Promise<void> };
        if (typeof closable.close === 'function') {
            try {
                await closable.close();
            } catch (err) {
                log.warn({ err: redactSecrets(err) }, 'checkpoint store close failed');
            }
        }
        try {
            await this.mcpManager.closeAll();
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
                // Fire-and-forget: feeds pendingRecapPromises so the new session's first turn can race it.
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

        // Inline prepend on the next user turn — <last_session> in the system prompt is too weak.
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
     * Compact the peer's active session: summarise the checkpoint message
     * history via LLM, then replace it with a single synthetic system
     * message containing that summary. Frees context-window space without
     * losing continuity. Used by the `/compact` slash command.
     */
    async compactSession(
        rawKey: string,
    ): Promise<{ messageCount: number; summary: string } | undefined> {
        const peerKey = rawKey.split('#')[0] ?? rawKey;
        const active = this.store.getActiveSession(peerKey);
        if (!active) return undefined;

        const threadId = `${peerKey}#${active.sessionId}`;

        // Load the latest checkpoint for this thread.
        const checkpoint = await CheckpointManager.latest<Record<string, unknown>>(
            this.checkpointer,
            threadId,
        );
        if (!checkpoint) return undefined;

        // Extract the messages array from the checkpoint state.
        const rawMessages = checkpoint.state['messages'];
        if (!Array.isArray(rawMessages) || rawMessages.length === 0) return undefined;

        // Require at least 10 messages — below that, compaction is wasteful.
        const MIN_MESSAGES_FOR_COMPACT = 10;
        if (rawMessages.length < MIN_MESSAGES_FOR_COMPACT) return undefined;

        // Build transcript text from persisted messages. Cap each message
        // body to 600 chars so very long assistant replies don't explode the
        // summarisation prompt.
        const PER_MESSAGE_CHAR_LIMIT = 600;
        const COMPACT_SYSTEM_PROMPT = [
            'You are a conversation summarizer.',
            'The following is a conversation between a user and an AI assistant.',
            'Create a concise but complete summary that preserves:',
            '- Key decisions and outcomes',
            '- Important facts or data discussed',
            '- Any tasks that were started or completed',
            '- The current state/context the user would need to continue work',
            '',
            'Format: A single paragraph or short bullet list. Be concise.',
        ].join('\n');

        const transcript = rawMessages
            .map((m: unknown) => {
                if (!m || typeof m !== 'object') return null;
                const msg = m as Record<string, unknown>;
                const role = typeof msg['role'] === 'string' ? msg['role'] : 'unknown';
                const rawContent = msg['content'];
                let body: string;
                if (typeof rawContent === 'string') {
                    body = rawContent;
                } else if (Array.isArray(rawContent)) {
                    body = rawContent
                        .filter(
                            (b): b is { type: string; text: string } =>
                                b !== null &&
                                typeof b === 'object' &&
                                (b as Record<string, unknown>)['type'] === 'text' &&
                                typeof (b as Record<string, unknown>)['text'] === 'string',
                        )
                        .map((b) => b.text)
                        .join('');
                } else {
                    return null;
                }
                const prefix = role === 'user' ? 'User' : role === 'assistant' ? 'Assistant' : 'System';
                return `${prefix}: ${body.slice(0, PER_MESSAGE_CHAR_LIMIT)}`;
            })
            .filter((line): line is string => line !== null)
            .join('\n');

        if (transcript.trim().length === 0) return undefined;

        let summary: string;
        try {
            const signal = AbortSignal.timeout(60_000);
            const response = await this.config.model.invoke(
                [
                    { role: 'system', content: COMPACT_SYSTEM_PROMPT },
                    { role: 'user', content: `CONVERSATION:\n${transcript}\n\nSummarize concisely.` },
                ],
                { signal },
            );
            const content = response.content;
            if (typeof content === 'string') {
                summary = content.trim();
            } else if (Array.isArray(content)) {
                summary = (content as ContentBlock[])
                    .filter((b): b is TextBlock => b.type === 'text')
                    .map((b) => b.text)
                    .join('')
                    .trim();
            } else {
                summary = '';
            }
        } catch (err) {
            log.warn({ err: redactSecrets(err), threadId }, '/compact: LLM summarisation failed');
            return undefined;
        }

        if (!summary) return undefined;

        // Replace checkpoint state with a single synthetic system message.
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

        // Evict cached thread so the next invoke reloads from the new checkpoint.
        this.evictPeerThreads(peerKey);

        log.info(
            { threadId, messageCount: rawMessages.length, summaryChars: summary.length },
            '/compact: session compacted',
        );

        return { messageCount: rawMessages.length, summary };
    }

    // Iterates every matching thread because post-/new the OLD thread is the one users want cleared.
    cancelPlan(rawKey: string): boolean {
        let cleared = false;
        for (const [threadId, entry] of this.threads) {
            if (!isThreadForRawKey(threadId, rawKey)) continue;
            const controller = entry.entry.planningController;
            if (!controller) continue;
            if (controller.cancel(threadId)) cleared = true;
        }
        return cleared;
    }

    getPlanState(rawKey: string): {
        mode: 'idle' | 'drafting' | 'approved';
        hasPlan: boolean;
        objective?: string;
    } | null {
        let best: { threadId: string; lastTouched: number; entry: ThreadEntry } | null = null;
        for (const [threadId, entry] of this.threads) {
            if (!isThreadForRawKey(threadId, rawKey)) continue;
            if (!entry.entry.planningController) continue;
            const touched = entry.lastUsedAt;
            if (!best || touched > best.lastTouched) {
                best = { threadId, lastTouched: touched, entry };
            }
        }
        if (!best) return null;
        return best.entry.entry.planningController!.getState(best.threadId);
    }

    listMcpServers(): ReadonlyArray<{
        name: string;
        status: 'connected' | 'skipped' | 'failed' | 'disabled';
        reason?: string;
        toolCount?: number;
    }> {
        const out: Array<{
            name: string;
            status: 'connected' | 'skipped' | 'failed' | 'disabled';
            reason?: string;
            toolCount?: number;
        }> = [];
        const connectedSet = new Set(this.mcpManager.connectedServerNames);
        const failedMap = this.mcpManager.failedServers;
        const skippedMap = this.mcpSkipReasons;

        for (const [name, cfg] of Object.entries(this.mcpServersCfg)) {
            if (cfg.enabled === false) {
                out.push({ name, status: 'disabled' });
                continue;
            }
            if (connectedSet.has(name)) {
                const tools = this.mcpToolCounts.get(name);
                out.push({ name, status: 'connected', ...(tools !== undefined ? { toolCount: tools } : {}) });
                continue;
            }
            if (failedMap[name]) {
                out.push({ name, status: 'failed', reason: failedMap[name] });
                continue;
            }
            if (skippedMap[name]) {
                out.push({ name, status: 'skipped', reason: skippedMap[name] });
                continue;
            }
            out.push({ name, status: 'skipped', reason: 'never loaded' });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Without evictCachedThreads, existing conversations keep their stale boot-time tool list.
    async reloadMcp(opts?: { evictCachedThreads?: boolean }): Promise<{
        connected: string[];
        skipped: Array<{ name: string; reason: string }>;
        failed: Array<{ name: string; reason: string }>;
        evictedCachedThreads: boolean;
    }> {
        const beforeConnected = new Set(this.mcpManager.connectedServerNames);

        const { servers, skipped } = await loadMcpServers(this.mcpServersCfg);

        this.mcpSkipReasons = { ...skipped };

        if (servers.length > 0) {
            await this.mcpManager.connect(servers);
        }

        if (this.mcpManager.connectedServerNames.length > 0) {
            this.mcpReady = bridgeAllTools(this.mcpManager).then((tools) => {
                this.mcpToolCounts.clear();
                for (const t of tools) {
                    this.mcpToolCounts.set(t.mcpServer, (this.mcpToolCounts.get(t.mcpServer) ?? 0) + 1);
                }
                return tools;
            });
            await this.mcpReady;
        }

        const afterConnected = new Set(this.mcpManager.connectedServerNames);
        const newlyConnected = [...afterConnected].filter((n) => !beforeConnected.has(n)).sort();

        const failedAfter = this.mcpManager.failedServers;

        let evictedCachedThreads = false;
        if (opts?.evictCachedThreads && newlyConnected.length > 0) {
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

        return {
            connected: newlyConnected,
            skipped: Object.entries(this.mcpSkipReasons).map(([name, reason]) => ({ name, reason })),
            failed: Object.entries(failedAfter).map(([name, reason]) => ({ name, reason })),
            evictedCachedThreads,
        };
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

            // The `messages` table is FTS-only; the agent's working memory lives in the checkpoint store.
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
        for (const k of [...this.threads.keys()]) {
            if (k === peerKey || k.startsWith(`${peerKey}#`)) {
                this.threads.delete(k);
            }
        }
    }

    private async runSessionExtraction(
        closedThreadId: string,
        closedSessionId: string,
        peerId: string,
    ): Promise<ExtractionResult | null> {
        if (!this.sessionExtractor) return null;

        const skillsPath = resolveWorkspacePath('skills');
        const existingSkills = scanExistingSkills(skillsPath);

        const result = await this.sessionExtractor.extract(
            closedThreadId,
            peerId,
            existingSkills,
        );
        if (!result) return null;

        try {
            this.store.setSessionSummary(closedSessionId, result.summary);

            // Write under proposed/ so the agent does NOT auto-load unreviewed skills.
            let proposedSkillName: string | null = null;
            if (result.skill_proposal) {
                const proposed = result.skill_proposal;
                const proposedRoot = pathJoin(skillsPath, 'proposed');
                try {
                    const written = await writeSkillFile(
                        proposedRoot,
                        proposed.name,
                        renderProposedSkillBody(proposed),
                    );
                    if (written) proposedSkillName = proposed.name;
                } catch (err) {
                    log.warn(
                        { err: (err as Error).message, name: proposed.name, peerId },
                        'skill proposal write failed',
                    );
                }
            }

            const skillsImproved: string[] = [];
            if (result.skill_lessons.length > 0) {
                for (const entry of result.skill_lessons) {
                    try {
                        const ok = await appendLessonsToSkill(
                            skillsPath,
                            entry.name,
                            entry.lessons,
                        );
                        if (ok) skillsImproved.push(entry.name);
                    } catch (err) {
                        log.warn(
                            { err: (err as Error).message, skill: entry.name, peerId },
                            'append lessons failed',
                        );
                    }
                }
            }

            log.info(
                {
                    peerId,
                    closedSessionId,
                    summaryChars: result.summary.length,
                    skillProposed: proposedSkillName,
                    skillsImproved,
                },
                'session extraction persisted',
            );
        } catch (err) {
            log.warn(
                { err: redactSecrets(err), peerId, closedSessionId },
                'session extraction persisted partially or failed',
            );
        }

        // 24h retention matches proactive reaper default; older child-worker checkpoints get pruned.
        const sweepable = this.checkpointer as {
            pruneByThreadPrefix?: (prefix: string, olderThanMs: number) => Promise<number>;
        };
        if (typeof sweepable.pruneByThreadPrefix === 'function') {
            const closedThreadId = `${peerId}#${closedSessionId}`;
            const ONE_DAY_MS = 24 * 60 * 60 * 1000;
            try {
                const deleted = await sweepable.pruneByThreadPrefix(
                    `${closedThreadId}:worker:`,
                    ONE_DAY_MS,
                );
                if (deleted > 0) {
                    log.debug(
                        { closedThreadId, deleted },
                        'pruned stale worker checkpoints for closed session',
                    );
                }
            } catch (err) {
                log.warn(
                    { err: redactSecrets(err), closedThreadId },
                    'worker-checkpoint sweep failed (non-fatal)',
                );
            }
        }
        return result;
    }

    private async getOrCreateThread(
        threadId: string,
        opts: { isProactive?: boolean } = {},
    ): Promise<ThreadEntry> {
        const existing = this.threads.get(threadId);
        if (existing) return existing;

        const identity = await this.config.resolveThread(threadId);

        const allMcpTools = await this.mcpReady;
        const filteredMcpTools = filterToolsForAgent(
            allMcpTools,
            this.entryDef.name,
            this.entryDef.mcpServers,
            this.mcpAssignToMap,
        );
        const { staticMcpTools, dynamicMcpTools } = this.partitionMcpToolsByPreload(filteredMcpTools);
        const mcpTools = dynamicMcpTools as unknown as BaseTool[];
        const mcpPreloadedTools = staticMcpTools as unknown as BaseTool[];

        const member = createTeamMember(this.entryDef, {
            model: this.config.model,
            userId: identity.userId,
            userName: identity.userName,
            store: this.store,
            memoryStore: this.memoryStore,
            extraInterceptors: [this.tokens],
            checkpointer: this.checkpointer,
            extraTools: mcpPreloadedTools.length > 0 ? mcpPreloadedTools : undefined,
            extraDynamicTools: mcpTools,
            teamRoster: this.buildTeamRoster(),
            personalities: this.personalities,
            // Stall guard: triggers ProviderError(0) → model-fallback before the 10-min turn wall.
            modelCallTimeoutMs: 45_000,
            ...(opts.isProactive ? { isProactive: true } : {}),
            ...(this.config.observability ? { observability: this.config.observability } : {}),
        });

        const registry = new TaskRegistry();
        const buildSubAgent = this.makeSubAgentFactory(identity, threadId);

        const entry: ThreadEntry = {
            entry: member,
            identity,
            registry,
            buildSubAgent,
            lastUsedAt: Date.now(),
            activeTurns: 0,
        };

        this.threads.set(threadId, entry);
        this.evictIfAtCapacity();

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

    private makeSubAgentFactory(identity: ThreadIdentity, threadId: string): SubAgentFactory {
        return (workerName: string): SubAgentRunner | undefined => {
            const def = this.allowedWorkers.find((w) => w.name === workerName);
            if (!def) return undefined;

            return async ({ task, signal }) => {
                const allMcpTools = await this.mcpReady;
                const filteredWorkerMcp = filterToolsForAgent(
                    allMcpTools,
                    def.name,
                    def.mcpServers,
                    this.mcpAssignToMap,
                );
                const { staticMcpTools: workerStaticMcp, dynamicMcpTools: workerDynamicMcp } =
                    this.partitionMcpToolsByPreload(filteredWorkerMcp);
                const workerMcpTools = workerDynamicMcp as unknown as BaseTool[];
                const workerPreloadedMcp = workerStaticMcp as unknown as BaseTool[];

                const workerModel = await resolveWorkerModel(def, this.config.model);

                // Catches "disabled in flopsy.json5 but still delegated" before a long, doomed run.
                const rosterMcpNames = this.mcpServersForWorker(def);
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

                // CheckpointStore is keyed by threadId; child threadId keeps main's slot pristine
                // and the deterministic hash lets a restarted gateway resume mid-flight.
                const childThreadId = `${threadId}:worker:${def.name}:${stableHash(task)}`;

                const worker = createTeamMember(def, {
                    model: workerModel,
                    userId: identity.userId,
                    userName: identity.userName,
                    store: this.store,
                    // Worker LLM calls bucket under the same (thread, day, model) key as the main agent.
                    extraInterceptors: [this.tokens],
                    extraTools: workerPreloadedMcp.length > 0 ? workerPreloadedMcp : undefined,
                    extraDynamicTools: workerMcpTools,
                    modelCallTimeoutMs: 60_000,
                    checkpointer: this.checkpointer,
                    ...(this.config.observability ? { observability: this.config.observability } : {}),
                });

                try {
                    const result = await worker.agent.invoke(
                        { messages: [{ role: 'user', content: task }] },
                        {
                            signal,
                            threadId: childThreadId,
                            configurable: {
                                userId: identity.userId,
                                threadId: childThreadId,
                                parentThreadId: threadId,
                                depth: 1,
                            },
                        },
                    );

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
                    return await this.foldWorkerReply(
                        fullReply,
                        workerName,
                        task,
                    );
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
            toolsets: def.toolsets ?? [],
            mcpServers: this.mcpServersForWorker(def),
        }));
    }

    private mcpServersForWorker(def: AgentDefinition): string[] {
        const pull = def.mcpServers;
        if (pull && pull.length > 0) return [...pull];
        return Object.entries(this.mcpAssignToMap)
            .filter(([, assigned]) =>
                assigned.includes(def.name) || assigned.includes('*'),
            )
            .map(([name]) => name);
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
        const dir = resolveWorkspacePath('cache', 'worker-outputs');
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
        const fileName = `${ts}-${workerName}-${slug}.md`;
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

        const relPath = path.relative(resolveWorkspacePath(''), fullPath) || fileName;

        return [
            `[handoff: ${workerName} → orchestrator]`,
            `Reply size: ${fullReply.length.toLocaleString()} chars (${(fullReply.length / 1024).toFixed(1)} KB)`,
            `Full reply saved to: ${relPath}`,
            `Use read_file("${relPath}") to load the rest if you need more than the preview below.`,
            '',
            '--- preview ---',
            fullReply.slice(0, WORKER_REPLY_PREVIEW_CHARS),
            '--- end preview ---',
        ].join('\n');
    }

    private partitionMcpToolsByPreload(
        tools: readonly BridgedTool[],
    ): { staticMcpTools: BridgedTool[]; dynamicMcpTools: BridgedTool[] } {
        const staticMcpTools: BridgedTool[] = [];
        const dynamicMcpTools: BridgedTool[] = [];
        for (const t of tools) {
            const cfg = this.mcpServersCfg[t.mcpServer];
            if (cfg && cfg.preload === true) {
                staticMcpTools.push(t);
            } else {
                dynamicMcpTools.push(t);
            }
        }
        return { staticMcpTools, dynamicMcpTools };
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
        if (this.threads.size <= this.maxThreads) return;

        let oldestId: string | undefined;
        let oldestTime = Infinity;
        for (const [id, e] of this.threads) {
            if (e.activeTurns > 0) continue;
            if (e.lastUsedAt < oldestTime) {
                oldestTime = e.lastUsedAt;
                oldestId = id;
            }
        }
        if (oldestId === undefined) {
            log.warn(
                { size: this.threads.size, cap: this.maxThreads },
                'thread cache at capacity but every entry is active; skipping eviction',
            );
            return;
        }
        const victim = this.threads.get(oldestId);
        this.threads.delete(oldestId);
        const evictedId = oldestId;
        victim?.entry.harnessInterceptor?.flush().catch((err: unknown) => {
            log.warn({ threadId: evictedId, err: redactSecrets(err) }, 'eviction flush failed');
        });
        log.debug({ evicted: oldestId, size: this.threads.size }, 'thread evicted (LRU)');
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

// FNV-1a 32-bit, base36 — non-cryptographic, deterministic across restarts.
function stableHash(input: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
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

    for (const m of media) {
        if (m.type !== 'image') continue;

        if (m.data) {
            imageBlocks.push({ type: 'image', mediaType: m.mimeType ?? 'image/jpeg', data: m.data });
        } else if (m.url) {
            imageBlocks.push({ type: 'image_url', url: m.url });
        } else {
            fallbackLines.push('[Image: content unavailable]');
        }
    }

    const bodyText = fallbackLines.length > 0
        ? `${text}\n${fallbackLines.join('\n')}`.trim()
        : text;

    if (imageBlocks.length === 0) return bodyText;

    return [...imageBlocks, { type: 'text', text: bodyText }];
}

function redactSecrets(err: unknown): { name?: string; message: string; stack?: string } {
    if (err instanceof Error) {
        return {
            name: err.name,
            message: scrubPii(err.message),
            stack: err.stack ? scrubPii(err.stack) : undefined,
        };
    }
    return { message: scrubPii(String(err)) };
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


// Frontmatter `name` MUST match the directory name or the skills() interceptor silently drops it.
function renderProposedSkillBody(p: SkillProposal): string {
    const cleanBody = p.body.replace(/^---[\s\S]*?\n---\n?/, '').trim();
    const today = new Date().toISOString().slice(0, 10);
    return [
        '---',
        `name: ${p.name}`,
        `description: ${p.description.replace(/\n/g, ' ').trim()}`,
        `when-to-use: ${p.when_to_use.replace(/\n/g, ' ').trim()}`,
        'source: extractor',
        `proposed-on: ${today}`,
        '---',
        '',
        cleanBody,
        '',
    ].join('\n');
}
