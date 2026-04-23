import { createLogger, resolveWorkspacePath, scrubPii } from '@flopsy/shared';
import type {
    AgentCallbacks,
    AgentHandler,
    AgentResult,
    InboundMedia,
    InvokeRole,
    TaskStatusSummary,
    ThreadStatusSnapshot,
} from '@flopsy/gateway';
import type { AgentDefinition, McpConfig } from '@flopsy/shared';
import type { BaseChatModel, BaseStore, CheckpointStore, BaseTool, Provider, ContentBlock } from 'flopsygraph';
import {
    ModelLoader,
    OllamaEmbedder,
    SqliteCheckpointStore,
    SqliteMemoryStore,
    tokenCounter,
} from 'flopsygraph';

import { parseModelString } from './bootstrap';
import { createTeamMember, resolveRole } from './factory';
import type { TeamMember, TeamRosterEntry } from './factory';
import { getSharedLearningStore } from './harness';
import {
    McpClientManager,
    bridgeAllTools,
    filterToolsForAgent,
    loadMcpServers,
    type BridgedTool,
} from './mcp';
import type { HarnessInterceptor, LearningStore } from './harness';
import { TaskRegistry } from './state/task-registry';
import type {
    SubAgentFactory,
    SubAgentRunner,
} from './tools/spawn-background-task';

const log = createLogger('team-handler');

/**
 * Thread identity resolved from a channel threadId.
 * Multi-tenant: each thread gets its own userId/domain so learning is isolated.
 */
export interface ThreadIdentity {
    readonly userId: string;
    readonly userName?: string;
    readonly domain?: string;
}

export type ThreadResolver = (threadId: string) => Promise<ThreadIdentity> | ThreadIdentity;

export interface TeamHandlerConfig {
    /**
     * The full team of agent definitions from config.agents. The handler
     * instantiates the entry member per-thread; the rest are kept on hand for
     * future delegation.
     */
    readonly team: ReadonlyArray<AgentDefinition>;

    /** Name of the entry agent — the one the gateway routes to. */
    readonly entryAgentName: string;

    /** Model for the entry agent. Loaded once in bootstrap. */
    readonly model: BaseChatModel;

    readonly resolveThread: ThreadResolver;

    /**
     * Max per-thread agents kept in memory. Older threads are evicted LRU-style.
     * Default: 100. Each thread holds ~a few MB (LLM state + harness context).
     */
    readonly maxThreads?: number;

    /** Override the shared LearningStore (for tests). */
    readonly store?: LearningStore;

    /**
     * Semantic memory store settings. Mirrors `flopsy.json5`'s `memory`
     * section — carries the embedder choice so gandalf's `manage_memory` /
     * `search_memory` tools can do cosine-similarity retrieval. When
     * `enabled: false`, no memoryStore is wired and flopsygraph's default
     * InMemoryStore kicks in (ephemeral, no search).
     */
    readonly memory?: {
        readonly enabled?: boolean;
        readonly embedder?: {
            readonly provider?: 'ollama';
            readonly model?: string;
            readonly baseUrl?: string;
        };
    };

    /**
     * MCP server registry (mirrors `flopsy.json5`'s `mcp` section). Each
     * configured + enabled server is spawned at handler construction; its
     * tools are auto-namespaced (`<server>__<tool>`) and routed to team
     * members per the per-server `assignTo` field OR per-agent
     * `mcpServers` allow-list.
     */
    readonly mcp?: McpConfig;
}

interface ThreadEntry {
    readonly entry: TeamMember;
    readonly identity: ThreadIdentity;
    /** Per-thread task map — background jobs, delegations, shell tasks. */
    readonly registry: TaskRegistry;
    /**
     * Closure that, given a worker name, returns a function that invokes
     * that worker's ReactAgent. Built once when the thread is instantiated;
     * each call lazily compiles the worker agent on first use and caches it.
     */
    readonly buildSubAgent: SubAgentFactory;
    lastUsedAt: number;
    activeTurns: number;
}

/**
 * TeamHandler — bridge between the gateway and the harness-enabled team.
 *
 * Receives the FULL team definition at construction; instantiates the entry
 * member lazily per thread. Non-entry teammates (legolas, gimli, …) will be
 * wired for delegation in a later phase — today they're registered but not
 * instantiated.
 */
export class TeamHandler implements AgentHandler {
    private readonly config: TeamHandlerConfig;
    private readonly maxThreads: number;
    private readonly store: LearningStore;
    private readonly threads = new Map<string, ThreadEntry>();
    private readonly entryDef: AgentDefinition;
    /**
     * Shared across every thread's main agent. Keyed by threadId so
     * cumulative token usage per conversation survives the `onGraphEnd`
     * reset at the end of each `.invoke()`. Surfaced by `queryStatus`.
     * It's both an `Interceptor` (passed into the agent's interceptor
     * stack) and a set of read accessors (`getTotals`, `entries`, ...).
     */
    private readonly tokens: ReturnType<typeof tokenCounter>;
    /**
     * One SQLite-backed CheckpointStore shared across every team member.
     * Lives in `<workspace>/harness/checkpoints.db` (separate from
     * state.db so large gzip'd state blobs don't thrash the WAL of the
     * learning store's small-row writes).
     *
     * Effect: a thread's graph state (messages, tool calls, intermediate
     * reasoning) survives process restart. Without this, the agent would
     * "forget" every conversation on each `npm run restart`. Session
     * search in state.db is complementary — it indexes the final
     * user/assistant turns; the checkpointer persists the LIVE turn state
     * mid-reasoning so a crashed run can resume exactly where it left off.
     */
    private readonly checkpointer: CheckpointStore;
    /**
     * Shared semantic memory store for the `manage_memory` / `search_memory`
     * tools that flopsygraph auto-wires into every ReactAgent. Backed by
     * SQLite at `<workspace>/harness/memory.db` so saved memories survive
     * restarts.
     *
     * When FLOPSY_EMBEDDER_MODEL is set (e.g. "nomic-embed-text"), an
     * OllamaEmbedder is attached so `search_memory` does cosine-similarity
     * ranking. Without it, the store is keyed storage only — search falls
     * back to a plain namespace listing, which is sufficient for small
     * libraries. See docs/memory.md.
     */
    private readonly memoryStore: BaseStore;
    /**
     * MCP client manager — owns the spawned MCP servers (Gmail, Notion, etc.).
     * Lazy-initialised: `mcpReady` resolves once `connect()` finishes, so
     * per-thread `createTeamMember` calls await it before pulling tools.
     */
    private readonly mcpManager: McpClientManager;
    private readonly mcpAssignToMap: Readonly<Record<string, readonly string[]>>;
    private readonly mcpServersCfg: McpConfig['servers'];
    private mcpReady: Promise<readonly BridgedTool[]> = Promise.resolve([]);

    constructor(config: TeamHandlerConfig) {
        this.config = config;
        this.maxThreads = config.maxThreads ?? 100;
        this.store = config.store ?? getSharedLearningStore();
        // One persistent checkpoint DB per process. gzip compression: graph
        // states grow quickly with tool results (web search blobs, file
        // reads), and the compress path halves storage for typical chat
        // flows with ~no CPU cost at our message volume. Separate file from
        // state.db because the two have very different write shapes —
        // mixing them trashes WAL checkpointing latency.
        this.checkpointer = new SqliteCheckpointStore({
            path: resolveWorkspacePath('harness', 'checkpoints.db'),
            compress: true,
        });

        // Persistent semantic memory store. Previously flopsygraph's default
        // InMemoryStore was used — it died on restart and lacked an embedder,
        // so `search_memory` returned nothing. That was the root cause of
        // the "memory system might be glitchy" behavior the user reported.
        //
        // Config lives in flopsy.json5 under `memory: { embedder: ... }`.
        // Default: persistent SQLite + Ollama `nomic-embed-text:v1.5` (274 MB,
        // 768-dim). Set `memory.enabled: false` to skip embedder wiring
        // (store still persists; search falls back to keyed listing).
        // If Ollama isn't running, embed() throws at query time; search
        // returns empty but save still succeeds — no gateway crash.
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
        this.memoryStore = new SqliteMemoryStore(
            resolveWorkspacePath('harness', 'memory.db'),
            embedder ? { embedder } : undefined,
        );
        log.info(
            {
                memoryPath: resolveWorkspacePath('harness', 'memory.db'),
                memoryEnabled,
                embedderModel: embedderCfg?.model ?? 'none',
                embedderBaseUrl: embedderCfg?.baseUrl ?? 'default',
            },
            'memoryStore ready',
        );
        // Keyed by threadId + persisted past graph end, so each conversation
        // accumulates across turns instead of resetting every .invoke().
        // Attached to the main agent's interceptor stack below (factory).
        this.tokens = tokenCounter({
            keyFn: (ctx) =>
                (ctx.configurable as { threadId?: string })?.threadId ?? ctx.threadId,
            persistAcrossGraphEnd: true,
            // Persist every model-call delta into state.db so tokens
            // survive process restarts and we get per-(thread, day, model)
            // attribution for /status. The callback is already in a
            // try/catch at the tokenCounter layer — a SQLite write error
            // won't break the model response path.
            onUpdate: (threadId, delta, _cumulative, ctx) => {
                const date = localDateString();
                this.store.recordTokenUsage({
                    threadId,
                    date,
                    provider: ctx.provider,
                    model: ctx.model,
                    input: delta.input,
                    output: delta.output,
                });
            },
        });

        // MCP wiring — fire-and-forget the connect; threads await
        // `mcpReady` before pulling tools so first-message slowness on
        // cold start is bounded by the slowest server (handled inside
        // McpClientManager with a 30s per-server timeout).
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
                    Object.entries(skipped).forEach(([name, reason]) =>
                        log.info({ server: name, reason }, 'mcp server skipped'),
                    );
                    if (servers.length === 0) return [];
                    await mcpManager.connect(servers);
                    return await bridgeAllTools(mcpManager);
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
        const entry = await this.getOrCreateThread(threadId);
        entry.lastUsedAt = Date.now();

        // NOTE: `callbacks.pending` contains texts the gateway ChannelWorker
        // received while the previous turn was still running. The worker drains
        // those back into its message queue AFTER this turn finishes
        // (see channel-worker.ts:278-282). Do NOT re-queue them into the harness
        // interceptor — that would cause each to be processed twice.

        entry.activeTurns += 1;
        try {
            // Forward the gateway's callbacks + per-thread state into the
            // agent's configurable. The delegation tools read these under
            // the keys documented in each tool file. Sub-agents built by
            // buildSubAgent receive a new configurable derived from this
            // one (depth + 1) so they can't delegate further.
            const configurable: Record<string, unknown> = {
                onReply: callbacks.onReply,
                sendPoll: callbacks.sendPoll,
                // Exposed to the messageQueue interceptor so mid-turn user
                // messages can be injected into the current turn's
                // reasoning. Interceptor calls this between tool results
                // and the next LLM call.
                drainPending: callbacks.drainPending,
                setDidSendViaTool: callbacks.setDidSendViaTool,
                reactToUserMessage: callbacks.reactToUserMessage,
                eventQueue: callbacks.eventQueue,
                registry: entry.registry,
                buildSubAgent: entry.buildSubAgent,
                depth: 0,
                threadId,
                userId: entry.identity.userId,
                // LearningStore handle for tools that need direct DB access
                // (search_past_conversations today; more to come). Keeps the
                // tool stateless and scoped by the userId/threadId already in
                // this configurable.
                store: this.store,
                // Message context — passed straight through from the gateway
                // so the SystemPromptFn (and any tool) can read clean values
                // instead of parsing the threadId.
                channelName: callbacks.channelName,
                // Channel-declared interactive capabilities (buttons, polls,
                // components, select). The SystemPromptFn reads these into
                // the runtime block so the model branches on what the
                // channel actually supports — not on channel name trivia.
                channelCapabilities: callbacks.channelCapabilities,
                peer: callbacks.peer,
                sender: callbacks.sender,
                messageId: callbacks.messageId,
                // Called by connect_service after OAuth succeeds so MCP servers
                // that require that provider are restarted with fresh credentials.
                onAuthSuccess: async (provider: string) => {
                    if (!this.mcpServersCfg || Object.keys(this.mcpServersCfg).length === 0) return;
                    try {
                        // Find all servers that requiresAuth for this provider.
                        const affected = Object.entries(this.mcpServersCfg)
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
                            { provider, err: err instanceof Error ? err.message : String(err) },
                            'onAuthSuccess mcp restart failed (non-fatal)',
                        );
                    }
                },
            };

            // Persist the user turn BEFORE invoking the agent so the message
            // survives even if the agent crashes mid-turn. The role is the
            // logical originator of the text — 'user' for direct messages
            // and 'assistant' for system-routed ones (task notifications,
            // etc.), which we treat as not-user-authored and skip persisting
            // to keep the search index focused on real human intent.
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

            const content = buildContent(text, media);

            const result = await entry.entry.agent.invoke(
                { messages: [{ role, content }] },
                { threadId, signal: callbacks.signal, configurable },
            );

            // boundary: flopsygraph returns AgentState with messages/tokenUsage typed
            // loosely across versions; narrow to the fields we actually consume.
            const messages =
                (result.messages as unknown as Array<{ role: string; content: unknown }>) ?? [];
            const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

            const reply = lastAssistant
                ? typeof lastAssistant.content === 'string'
                    ? lastAssistant.content
                    : JSON.stringify(lastAssistant.content)
                : null;

            // boundary: flopsygraph TokenUsage; we only surface prompt+completion.
            const usage = result.tokenUsage as unknown as
                | { promptTokens: number; completionTokens: number }
                | undefined;

            // Persist the assistant's final reply so session search can find
            // it later. We only record the REPLY STRING — tool calls,
            // intermediate reasoning, and worker outputs stay in flopsygraph's
            // checkpoint (which is the right place for them) to keep the FTS
            // index focused on what the user actually saw.
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

    /**
     * Snapshot the thread's running/recent tasks for the gateway's slash
     * commands (e.g. /status). Returns undefined when the thread hasn't
     * been instantiated yet — typical on the first user message.
     */
    queryStatus(threadId: string): ThreadStatusSnapshot | undefined {
        const entry = this.threads.get(threadId);

        // Graceful degradation: when the thread hasn't been instantiated yet
        // (no invoke has run — common right after a restart, since the thread
        // map is in-memory), we still surface team roster, token history from
        // state.db, and config so /status is useful on first load. Tasks and
        // in-flight status go empty since there's nothing running.
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

        // Recent tasks sorted newest-first, capped at 5 to keep /status
        // output readable.
        recent.sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0));
        recent.length = Math.min(recent.length, 5);

        // Today's tokens from state.db (daily bucket) + per-model breakdown.
        // In-memory `this.tokens.getTotals(threadId)` still reflects
        // cumulative-since-process-start; we prefer the persisted daily view
        // because it survives restarts and gives per-model attribution. Top
        // 5 models by volume keeps /status output scannable.
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

        // Build team roster — one entry per configured non-main worker.
        // A worker is `running` if the TaskRegistry has an active teammate
        // task pinned to that worker; otherwise `idle`. Disabled workers
        // (enabled: false in flopsy.json5) show separately so the user can
        // see them without them being indistinguishable from idle.
        const now = Date.now();

        // Per-worker last-active timestamp: the most recent endedAtMs
        // across this worker's teammate tasks (completed / failed /
        // killed). /status uses it to render "idle · last active 43s ago".
        const lastActiveByWorker = new Map<string, number>();
        for (const t of tasks) {
            if (t.type !== 'teammate' || !t.workerName || t.endedAt == null) continue;
            const prev = lastActiveByWorker.get(t.workerName) ?? 0;
            if (t.endedAt > prev) lastActiveByWorker.set(t.workerName, t.endedAt);
        }
        // Include the main agent in the roster too — users expect gandalf
        // listed alongside workers at a glance. Main has no "teammate" tasks
        // (those are per-worker delegations), so it shows 'idle' unless we
        // later add a turn-in-flight signal.
        const team = this.config.team
            .map((def): import('@flopsy/gateway').TeamMemberStatus => {
                if (!def.enabled) {
                    return {
                        name: def.name,
                        type: def.type,
                        enabled: false,
                        status: 'disabled',
                    };
                }
                // Find the first active task whose worker is this agent
                // (teammate tasks carry workerName; one worker → at most one
                // concurrent teammate task per thread, per the registry).
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
                    };
                }
                return {
                    name: def.name,
                    type: def.type,
                    enabled: true,
                    status: 'idle',
                    ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
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
        } finally {
            this.threads.delete(threadId);
        }
    }

    async shutdown(): Promise<void> {
        const entries = [...this.threads.values()];
        this.threads.clear();
        await Promise.allSettled(
            entries.map((e) => e.entry.harnessInterceptor?.flush() ?? Promise.resolve()),
        );
        // Flush + close the checkpoint DB cleanly. If the store exposes a
        // close() method (SqliteCheckpointStore does), call it so WAL is
        // checkpointed to the main DB file before the process exits —
        // otherwise the next boot spends extra cycles replaying WAL.
        const closable = this.checkpointer as { close?: () => void | Promise<void> };
        if (typeof closable.close === 'function') {
            try {
                await closable.close();
            } catch (err) {
                log.warn({ err: redactSecrets(err) }, 'checkpoint store close failed');
            }
        }
        // Tear down spawned MCP child processes so they don't linger.
        try {
            await this.mcpManager.closeAll();
        } catch (err) {
            log.warn({ err: redactSecrets(err) }, 'mcp shutdown failed');
        }
    }

    private async getOrCreateThread(threadId: string): Promise<ThreadEntry> {
        const existing = this.threads.get(threadId);
        if (existing) return existing;

        const identity = await this.config.resolveThread(threadId);

        // Pull MCP tools assigned to this main agent. Awaits the
        // initial connect (first thread instantiation eats any cold-
        // start cost; subsequent threads get the cached result).
        const allMcpTools = await this.mcpReady;
        const mcpTools = filterToolsForAgent(
            allMcpTools,
            this.entryDef.name,
            this.entryDef.mcpServers,
            this.mcpAssignToMap,
        ) as unknown as BaseTool[];

        const member = createTeamMember(this.entryDef, {
            model: this.config.model,
            userId: identity.userId,
            userName: identity.userName,
            store: this.store,
            // Main-agent only: token accounting interceptor shared across
            // threads, keyed by threadId. Factory appends it to the
            // interceptor stack when role === 'main'.
            extraInterceptors: [this.tokens],
            // Persistent thread state. flopsygraph auto-resumes from the
            // latest checkpoint for this threadId on subsequent .invoke()s,
            // so a restart doesn't wipe the conversation.
            checkpointer: this.checkpointer,
            // Persistent semantic memory — backs manage_memory/search_memory.
            // Without this, flopsygraph defaulted to InMemoryStore which
            // lost every saved memory on restart and (lacking an embedder)
            // made search_memory return nothing — root cause of the
            // "glitchy memory" symptom.
            memoryStore: this.memoryStore,
            // Filtered MCP tools (gmail__send, notion__search_pages, etc.).
            // Empty when no servers connect or none route to this agent.
            // Passed as DYNAMIC so flopsygraph's DCL handles discovery:
            // schemas land in the prompt only when >10 items (short names +
            // descriptions) and agent calls __search_tools__/__load_tool__
            // to activate. Keeps NVIDIA's system prompt from ballooning.
            extraDynamicTools: mcpTools,
            // Team capability roster — renders into gandalf's system
            // prompt so it knows each worker's actual MCP kit.
            teamRoster: this.buildTeamRoster(),
            // Main agent keeps the shared user-preference namespace so user
            // facts saved by gandalf are durable across all topics. Workers
            // each get an isolated `memories:<name>` namespace (set by
            // factory default) to prevent cross-worker key collisions.
            memoryNamespace: 'memories',
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

    /**
     * Closure factory: given an identity, returns a function that looks up a
     * worker by name and runs it as an ephemeral sub-agent. Workers are
     * built fresh per call — Claude Code's approach — so their context is
     * isolated. The parent's LearningStore IS shared so worker lessons flow
     * back into the same pool.
     */
    private makeSubAgentFactory(identity: ThreadIdentity, threadId: string): SubAgentFactory {
        return (workerName: string): SubAgentRunner | undefined => {
            const def = this.allowedWorkers.find((w) => w.name === workerName);
            if (!def) return undefined;

            // Each delegation builds a fresh TeamMember so context doesn't
            // bleed across tasks. Depth=1 comes from the tool's configurable
            // construction below (main agent sets depth=0; sub-agent sets
            // depth=1 and must not delegate further — enforced in-tool).
            return async ({ task, signal }) => {
                // Same MCP filtering as the main agent — workers can have
                // their own `mcpServers` allow-list OR receive servers
                // tagged with their name in `assignTo`. mcpReady is
                // already settled by the time gandalf delegates.
                const allMcpTools = await this.mcpReady;
                const workerMcpTools = filterToolsForAgent(
                    allMcpTools,
                    def.name,
                    def.mcpServers,
                    this.mcpAssignToMap,
                ) as unknown as BaseTool[];

                // Resolve the worker's configured model. Without this
                // every worker would run on gandalf's model and /status
                // would show everything under one bucket — masking which
                // worker actually did the work. Falls back to the main's
                // model only if the worker has no `model` in flopsy.json5.
                const workerModel = await resolveWorkerModel(def, this.config.model);

                // P5 tool-call telemetry: warn when a worker's roster-listed
                // MCP servers produced zero bridged tools. This catches the
                // "disabled MCP in flopsy.json5 but still delegated to"
                // scenario before the worker runs for minutes and gets killed.
                const rosterMcpNames = (() => {
                    const pull = def.mcpServers;
                    if (pull && pull.length > 0) return pull;
                    return Object.entries(this.mcpAssignToMap)
                        .filter(([, assigned]) =>
                            assigned.includes(def.name) || assigned.includes('*'),
                        )
                        .map(([name]) => name);
                })();
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

                const worker = createTeamMember(def, {
                    model: workerModel,
                    userId: identity.userId,
                    userName: identity.userName,
                    store: this.store,
                    // Pass tokenCounter to workers so their LLM calls
                    // (legolas web-lookup, gimli analysis, saruman's 10-ish
                    // deep-research calls) land in state.db under the same
                    // (thread, day, model) key — /status shows them all.
                    extraInterceptors: [this.tokens],
                    // Share the same memory store so workers see the facts
                    // gandalf has saved across turns (and vice versa).
                    // Namespace isolation is the store's job, not ours.
                    memoryStore: this.memoryStore,
                    // Same DCL treatment as the main agent — workers also
                    // see only __search_tools__/__load_tool__ until they
                    // explicitly activate an MCP tool.
                    extraDynamicTools: workerMcpTools,
                });

                try {
                    const result = await worker.agent.invoke(
                        { messages: [{ role: 'user', content: task }] },
                        {
                            signal,
                            // Propagate the conversation's threadId so the
                            // tokenCounter keys worker LLM calls into the
                            // SAME (thread, day, model) bucket as gandalf's.
                            // Without this, worker tokens would land under
                            // an auto-generated runId and /status would miss
                            // them for the conversation the user is in.
                            threadId,
                            configurable: {
                                userId: identity.userId,
                                threadId,
                                depth: 1,
                                // Workers never receive onReply / eventQueue /
                                // registry — they can't send directly to the
                                // user and can't delegate further. MAX_DEPTH
                                // is enforced in-tool as a second line of
                                // defence.
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
                    return typeof lastAssistant.content === 'string'
                        ? lastAssistant.content
                        : JSON.stringify(lastAssistant.content);
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

    /**
     * Workers gandalf is allowed to delegate to. Derived once from the team
     * config. Respects the main agent's `workers: string[]` allowlist if
     * present; otherwise defaults to every enabled non-main agent.
     */
    /**
     * Build the capability roster for the main agent's system prompt —
     * one entry per enabled peer, listing toolsets + MCP servers that
     * will actually route to them. Without this, gandalf picks workers
     * by name alone and hallucinates capabilities that aren't there.
     *
     * Filters to enabled workers that are in gandalf's `workers` list
     * (same filter `allowedWorkers` uses); skips disabled to keep the
     * prompt concise.
     */
    private buildTeamRoster(): readonly TeamRosterEntry[] {
        const workers = this.allowedWorkers;
        return workers.map((def): TeamRosterEntry => {
            // MCP servers this worker will see:
            //   - explicit pull via `def.mcpServers` takes precedence
            //   - otherwise, each server whose assignTo includes this
            //     worker's name (or the "*" broadcast wildcard)
            const pull = def.mcpServers;
            const mcpServers = pull && pull.length > 0
                ? [...pull]
                : Object.entries(this.mcpAssignToMap)
                    .filter(([, assigned]) =>
                        assigned.includes(def.name) || assigned.includes('*'),
                    )
                    .map(([name]) => name);
            return {
                name: def.name,
                type: def.type,
                ...(def.domain !== undefined ? { domain: def.domain } : {}),
                toolsets: def.toolsets ?? [],
                mcpServers,
            };
        });
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Local YYYY-MM-DD for the process's timezone. Used as the `date` column
 * in `token_usage` so day boundaries respect the user's wall clock rather
 * than UTC (which would otherwise split "today" in two for non-UTC users).
 * Computed in JS instead of `date('now')` in SQLite so a long-running
 * transaction won't straddle midnight and land writes on the wrong day.
 */
/**
 * Resolve the BaseChatModel a worker should run on. If the worker has
 * its own `model: "provider:name"` in flopsy.json5, build it via the
 * ModelLoader singleton (cached across calls). Otherwise inherit the
 * main agent's model so small setups still work without per-worker
 * config.
 *
 * On load failure (provider unreachable, bad name) we log and fall back
 * to the main — a degraded worker is better than a crashed turn, and
 * the 429 triggers the modelFallback interceptor anyway.
 */
async function resolveWorkerModel(
    def: AgentDefinition,
    fallback: BaseChatModel,
): Promise<BaseChatModel> {
    if (!def.model) return fallback;
    try {
        const ref = parseModelString(def.model);
        // Trust the config: flopsy.json5's model strings are authored
        // by the user and load errors are caught below.
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

function localDateString(d: Date = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Secret redaction for error logs (shared/scrubPii on error message + stack)
// ---------------------------------------------------------------------------

/**
 * Build the LLM content payload for an inbound turn.
 *
 * Images with binary data or a URL become vision ContentBlocks placed before
 * the text so the model can reference them naturally. Images without data (e.g.
 * oversized or download-failed) fall back to an inline notice in the text body.
 *
 * Non-image media types (video, document, sticker, location) are already
 * encoded as structured text by the channel adapters — nothing extra to emit.
 */
/**
 * Build the LLM content payload for an inbound turn.
 *
 * Images with binary data or a URL become vision ContentBlocks placed before
 * the text so the model can reference them naturally. Images without data (e.g.
 * oversized or download-failed) fall back to an inline notice appended to the
 * text body so the model knows something was there but couldn't be loaded.
 *
 * Non-image media types (video, document, sticker, location) are already
 * encoded as structured text by the channel adapters — nothing extra to emit.
 */
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
