import { readFileSync, existsSync, mkdirSync } from 'fs';
import type { ZodType } from 'zod';
import {
    autoSearchFn,
    createDeepResearcher,
    createReactAgent,
    filesystem,
    humanApproval,
    injectContext,
    memorySnapshot,
    messageQueue,
    modelFallback,
    planning,
    skills,
    todoList,
    RetryModel,
    createSession as createSandboxSession,
    BaseSandboxSession,
} from 'flopsygraph';
import type {
    BaseTool,
    BaseChatModel,
    BaseStore,
    ChatMessage,
    CheckpointStore,
    CompiledGraph,
    DeepResearchState,
    Interceptor,
    ModelFallbackOptions,
    ModelRef,
    PlanningInterceptor,
    SandboxConfig as FlopsygraphSandboxConfig,
    SystemPromptFn,
} from 'flopsygraph';
import type { AgentDefinition } from '@flopsy/shared';
import { createLogger, resolveWorkspacePath, workspace } from '@flopsy/shared';
import {
    HarnessInterceptor,
    toolLoopDedup,
    sanitizeToolCallNoise,
    reflectionNudge,
} from './harness';
import { CorrectionInterceptor, setCorrectionStore } from './harness';
import type { LearningStore } from './harness';
import { SkillUsageStore } from './harness/review';
import type { PersonalityRegistry } from './personalities';
import { resolvePersonality } from './personalities';
import { compactor, defaultContextWindowFor } from 'flopsygraph';
import { resolveToolsets } from './toolsets';
import { askUserTool } from './tools/ask-user';
import { connectServiceTool } from './tools/connect-service';
import { sendMessageTool } from './tools/send-message';
import { sendPollTool } from './tools/send-poll';
import { searchConversationHistoryTool } from './tools/search-conversation-history';
import { spawnBackgroundTaskTool } from './tools/spawn-background-task';
import { delegateTaskTool } from './tools/delegate-task';
import { reactTool } from './tools/react';
import { skillManageTool } from './tools/skill-manage';
import { manageScheduleTool } from './tools/manage-schedule';
import { notifyTeammateTool } from './tools/notify-teammate';

const log = createLogger('team-factory');

import { EventEmitter } from 'node:events';
import type { BaseChatModel as _BaseChatModel, CompactorAccessors, CompactorCheck, CompactionEvent } from 'flopsygraph';
import type { ChatMessage as _ChatMessage } from 'flopsygraph';

const compactorRegistry = new Map<string, CompactorAccessors>();

export function getCompactorStatus(agentName: string, threadId: string): CompactorCheck | undefined {
    return compactorRegistry.get(agentName)?.getLastCheck(threadId);
}

/** Subscribe to live compaction events. */
export const compactionEvents = new EventEmitter();
export type CompactionEventWithAgent = CompactionEvent & { agentName: string };

export const COMPACTION_SUMMARY_PROMPT = [
    'You are a conversation summarizer.',
    'Produce a concise summary that preserves: key decisions and outcomes,',
    'important facts or data discussed, started/completed tasks, and the current',
    'state/context the user needs to continue work.',
    'Format: one paragraph or short bullet list. Be concise.',
].join(' ');

export async function summarizeForCompaction(
    model: _BaseChatModel,
    messages: _ChatMessage[],
    timeoutMs = 60_000,
): Promise<string> {
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await model.invoke(
        [{ role: 'system', content: COMPACTION_SUMMARY_PROMPT }, ...messages],
        { signal },
    );
    if (typeof res.content === 'string') return res.content.trim();
    if (Array.isArray(res.content)) {
        return res.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
    }
    return '';
}

export interface CreateTeamMemberOptions {
    readonly model: BaseChatModel;
    readonly userId: string;
    readonly userName?: string;
    readonly store: LearningStore;
    readonly extraTools?: ReadonlyArray<BaseTool>;
    readonly extraDynamicTools?: ReadonlyArray<BaseTool>;
    readonly extraInterceptors?: ReadonlyArray<Interceptor>;
    /** Shared between main and workers — each worker invokes with a
     *  derived child threadId (`${parent}:worker:<name>:<hash>`) so
     *  persistence doesn't clobber the parent slot. */
    readonly checkpointer?: CheckpointStore;
    readonly memoryStore?: BaseStore;
    readonly teamRoster?: ReadonlyArray<TeamRosterEntry>;
    readonly personalities?: PersonalityRegistry;
    readonly memoryNamespace?: string;
    readonly modelCallTimeoutMs?: number;
    readonly maxIterations?: number;
    readonly observability?: import('flopsygraph').Observability;
    readonly isProactive?: boolean;
    /**
     * Build the main agent as a "single-agent fire": strips team delegation
     * (`delegate_task`, `spawn_background_task`), interactive tools (`ask_user`,
     * `react`, `send_poll`), and `manage_schedule` (recursion guard).
     * Caller must pass `teamRoster: []` and skip memory writes accordingly.
     */
    readonly proactiveMode?: boolean;
    /** Zod schema for flopsygraph's `__respond__` tool; refuses termination without schema-valid value. */
    readonly outputSchema?: ZodType;
    /**
     * Per-namespace char budgets for the `memory` tool. Populated from
     * `cfg.memory.{userCharLimit, memoryCharLimit}`: `profile` uses userCharLimit;
     * other namespaces share memoryCharLimit.
     */
    readonly memoryCharLimits?: Readonly<Record<string, number>>;
}

export interface TeamRosterEntry {
    readonly name: string;
    readonly type: string;
    readonly domain?: string;
    /** Non-MCP capability groups (from `def.toolsets`). */
    readonly toolsets: ReadonlyArray<string>;
    /** MCP server names the worker will see (from push `assignTo` + pull `mcpServers`). */
    readonly mcpServers: ReadonlyArray<string>;
}

export type WorkerGraph = CompiledGraph<{ messages: ChatMessage[] } & Record<string, unknown>>;

export interface TeamMember {
    readonly name: string;
    readonly type: string;
    readonly domain: string | undefined;
    readonly graph: 'react' | 'deep-research';
    readonly agent: WorkerGraph;
    readonly harnessInterceptor?: HarnessInterceptor;
    readonly tools: ReadonlyArray<BaseTool>;
    readonly sandboxSession?: BaseSandboxSession;
    readonly planningController?: PlanningInterceptor;
    readonly skillUsageStore?: SkillUsageStore;
}

export function resolveRole(def: AgentDefinition): 'main' | 'worker' {
    if (def.role) return def.role;
    return def.type === 'main' ? 'main' : 'worker';
}

export function createTeamMember(def: AgentDefinition, opts: CreateTeamMemberOptions): TeamMember {
    const role = resolveRole(def);
    const graphKind = def.graph ?? 'react';

    if (graphKind === 'deep-research') {
        return buildDeepResearchMember(def, opts, role);
    }

    const baseTools = [...resolveToolsets(def.toolsets ?? []), ...(opts.extraTools ?? [])];

    // Proactive fires disable delegation, interactive, recursion-creating, and
    // in-conversation messaging tools. Engine delivers; agent must return prose
    // or call __respond__. Workers (role !== 'main') are unaffected.
    const PROACTIVE_DISABLED_CONTROL_TOOLS: ReadonlySet<string> = new Set([
        'delegate_task',
        'spawn_background_task',
        'ask_user',
        'react',
        'send_poll',
        'manage_schedule',
        'send_message',
    ]);

    const controlTools: BaseTool[] = (() => {
        if (role !== 'main') return [delegateTaskTool, spawnBackgroundTaskTool, notifyTeammateTool];

        const mainTools = [
            sendMessageTool,
            sendPollTool,
            askUserTool,
            reactTool,
            spawnBackgroundTaskTool,
            delegateTaskTool,
            searchConversationHistoryTool,
            connectServiceTool,
            skillManageTool,
            manageScheduleTool,
        ];

        if (opts.proactiveMode) {
            return mainTools.filter((t) => !PROACTIVE_DISABLED_CONTROL_TOOLS.has(t.name));
        }
        return mainTools;
    })();

    const tools = (() => {
        const seen = new Map<string, BaseTool>();
        for (const t of [...baseTools, ...controlTools]) {
            if (seen.has(t.name)) {
                log.debug(
                    { agent: def.name, tool: t.name },
                    'duplicate tool name — last occurrence wins',
                );
            }
            seen.set(t.name, t);
        }
        return [...seen.values()];
    })();

    // OpenAI hard-caps tool count at 128; excess spills into DCL dynamic bucket.
    const OPENAI_TOOLS_HARD_CAP = 128;
    let spilledTools: BaseTool[] = [];
    if (tools.length > OPENAI_TOOLS_HARD_CAP) {
        spilledTools = tools.splice(OPENAI_TOOLS_HARD_CAP);
        log.warn(
            { agent: def.name, cap: OPENAI_TOOLS_HARD_CAP, spilled: spilledTools.length },
            'static tool count exceeds OpenAI hard cap — excess tools moved to DCL dynamic bucket',
        );
    }

    const systemPrompt = buildSystemPrompt(
        def,
        role,
        opts.store,
        opts.userId,
        opts.teamRoster,
        opts.personalities,
        opts.isProactive,
        tools,
    );

    const harnessInterceptor = new HarnessInterceptor({
        userId: opts.userId,
        userName: opts.userName,
        domain: def.domain,
        store: opts.store,
    });

    const interceptors: Interceptor[] = [harnessInterceptor];

    interceptors.push(toolLoopDedup());
    interceptors.push(sanitizeToolCallNoise());
    interceptors.push(reflectionNudge());

    // Correction feedback — persists user corrections to memory for future retrieval.
    // Only on main agent (workers don't interact directly with the user).
    if (role === 'main' && opts.memoryStore) {
        setCorrectionStore(opts.memoryStore);
        interceptors.push(new CorrectionInterceptor());
    }

    if (def.fallback_models?.length) {
        // Preserve per-fallback `config` so fallback model settings reach the built model.
        const fallbacks = def.fallback_models.map(
            (m) => ({
                provider: m.provider,
                name: m.name ?? '',
                ...(m.config ? { config: m.config } : {}),
            }) as unknown as ModelRef,
        );
        const onFallback: NonNullable<ModelFallbackOptions['onFallback']> = ({
            from,
            to,
            error,
            depth,
        }) => {
            log.warn(
                {
                    agent: def.name,
                    from,
                    to: `${to.provider}/${to.name}`,
                    depth,
                    err: error.message,
                },
                'model fallback triggered',
            );
        };
        // 180s tolerates Ollama cold-start (24GB Q4 quants can take 30-90s to warm).
        interceptors.push(modelFallback({ fallbacks, onFallback, perAttemptTimeoutMs: 180_000 }));
    }

    // Skip when the worker's toolsets already include "filesystem" — ToolRegistry rejects duplicates.
    const toolsetsHaveFilesystem = (def.toolsets ?? []).includes('filesystem');
    if (!toolsetsHaveFilesystem) {
        interceptors.push(
            filesystem({
                allow: ['read_file', 'ls', 'glob', 'grep'],
                mounts: [
                    { virtualPath: '/workspace', hostPath: resolveWorkspacePath('') },
                    { virtualPath: '/skills',    hostPath: workspace.skills() },
                ],
            }),
        );
    }

    // skills() throws on readdir failure, so the directory MUST exist.
    const skillsPath = workspace.skills();
    mkdirSync(skillsPath, { recursive: true });
    const skillUsageStore = new SkillUsageStore(skillsPath);
    interceptors.push(
        skills(skillsPath, {
            deltaOnly: true,
            onError: (err) =>
                log.warn({ agent: def.name, err }, 'skill load error'),
            onSkillRead: (name) => skillUsageStore.view(name),
            filterSkill: (name) => skillUsageStore.get(name)?.state !== 'archived',
            // Per-agent filtering via `agent-affinity` and `requires_toolsets` metadata.
            agentName: def.name,
            activeToolsets: def.toolsets ?? [],
        }),
    );

    interceptors.push(todoList());

    // Frozen per-thread snapshot of persistent memory namespaces, injected as <memory> block.
    if (opts.memoryStore) {
        const snapshotNamespaces = [
            { name: 'profile',    label: 'USER PROFILE (stable traits learned across sessions)', cap: 1200 },
            { name: 'facts',      label: 'FACTS (atomic key/value notes)',                       cap: 1500 },
            { name: 'directives', label: 'DIRECTIVES (imperative rules to obey)',                cap: 800  },
            { name: 'memory',     label: 'MEMORY (shared persistent notes)',                   cap: 2200 },
        ];
        // Each agent sees its own accumulated expertise in addition to shared namespaces.
        snapshotNamespaces.push({
            name: `${def.name}-memory`,
            label: `${def.name.toUpperCase()} EXPERTISE (patterns and lessons learned in your domain)`,
            cap: 1500,
        });
        interceptors.push(
            memorySnapshot({
                store: opts.memoryStore,
                namespaces: snapshotNamespaces,
            }),
        );
    }

    let planningController: PlanningInterceptor | undefined;

    if (role === 'main') {
        interceptors.push(
            messageQueue({
                onInject: (msgs, phase) => {
                    log.info(
                        { count: msgs.length, phase, preview: msgs[0]?.slice(0, 80) },
                        'mid-turn user message injected',
                    );
                },
            }),
        );

        // keyFn uses ctx.threadId alone — onGraphStart and beforeToolCall must
        // resolve to the SAME key or the approval gate gets stuck.
        planningController = planning({
            approvalMode: 'chat-turn',
            keyFn: (ctx) => ctx.threadId,
            persistAcrossGraphEnd: true,
            planFirst: false,
        });
        interceptors.push(planningController);
    } else {
        interceptors.push(
            planning({
                approvalMode: 'none',
                keyFn: (ctx) =>
                    (ctx.configurable as { threadId?: string })?.threadId ??
                    ctx.threadId,
                persistAcrossGraphEnd: false,
                planFirst: false,
            }),
        );
    }

    if (opts.extraInterceptors?.length) {
        interceptors.push(...opts.extraInterceptors);
    }

    if (def.approvals) {
        interceptors.push(
            humanApproval({
                tools: def.approvals.tools,
                reviewPolicy: def.approvals.actions,
            }),
        );
    }

    // Threshold = window - outputTokens(8K) - bufferTokens(13K) via defaultContextWindowFor.
    const compactorInst = compactor({
        getContextWindow: defaultContextWindowFor,
        summarize: (msgs) => summarizeForCompaction(opts.model, msgs),
        onCompact: (event) => {
            compactionEvents.emit('compaction', { ...event, agentName: def.name });
        },
    });
    compactorRegistry.set(def.name, compactorInst);
    interceptors.push(compactorInst);

    const staticNames = new Set(tools.map((t) => t.name));
    const dynamicTools = [...spilledTools, ...(opts.extraDynamicTools ?? [])].filter(
        (t) => !staticNames.has(t.name),
    );

    const sandboxOpts = buildSandboxOptions(def);

    // Workers fail fast (1 retry) so the parent's envelope isn't burned on retries.
    const retryMax = role === 'worker' ? 1 : 3;
    // Workers run sequential tool chains; main agents parallelize independent calls.
    const enableParallelToolCalls = role === 'main';
    // Identity files routed to flopsygraph's agentMemory interceptor (missing files are skipped).
    const memoryFiles = (() => {
        if (role === 'main' && !opts.isProactive) {
            return [
                workspace.config('SOUL.md'),
                workspace.config('AGENTS.md'),
                workspace.config('USER.md'),
            ];
        }
        if (role === 'worker') {
            const workerDir = workspace.roles() + `/worker/${def.name}`;
            const files: string[] = [];
            const soulPath = workerDir + '/SOUL.md';
            const agentsPath = workerDir + '/AGENTS.md';
            if (existsSync(soulPath)) files.push(soulPath);
            if (existsSync(agentsPath)) files.push(agentsPath);
            return files;
        }
        return [];
    })();

    const agent = createReactAgent({
        model: new RetryModel(opts.model, { maxRetries: retryMax, baseDelayMs: 1000, maxDelayMs: 30_000 }),
        tools,
        dynamicTools,
        systemPrompt,
        interceptors,
        ...(memoryFiles.length > 0 ? { memory: memoryFiles } : {}),
        maxIterations: opts.maxIterations ?? 30,
        parallelToolCalls: enableParallelToolCalls,
        ...(opts.observability ? { observability: opts.observability } : {}),
        ...(opts.checkpointer ? { checkpointer: opts.checkpointer } : {}),
        ...(opts.memoryStore ? { memoryStore: opts.memoryStore } : {}),
        memoryNamespace: opts.memoryNamespace ?? `${def.name}-memory`,
        ...(opts.memoryCharLimits ? { memoryCharLimits: opts.memoryCharLimits } : {}),
        ...(opts.modelCallTimeoutMs !== undefined
            ? { modelCallTimeoutMs: opts.modelCallTimeoutMs }
            : {}),
        ...(sandboxOpts.session ? { sandbox: sandboxOpts.session } : {}),
        ...(sandboxOpts.programmaticToolCalling
            ? { programmaticToolCalling: true }
            : {}),
        ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
        toolOutputOffloadDir: resolveWorkspacePath('worker', 'tool-outputs'),
    }) as unknown as WorkerGraph;

    if (sandboxOpts.session) {
        log.info(
            {
                name: def.name,
                backend: sandboxOpts.backend,
                language: sandboxOpts.language,
                programmaticToolCalling: sandboxOpts.programmaticToolCalling,
                // Surface networkEnabled/hardened/untrusted so operators can verify config landed.
                networkEnabled: (sandboxOpts.session as unknown as { config?: { networkEnabled?: boolean } }).config?.networkEnabled,
                hardened: (sandboxOpts.session as unknown as { config?: { hardened?: boolean } }).config?.hardened,
                untrusted: (sandboxOpts.session as unknown as { config?: { untrusted?: boolean } }).config?.untrusted,
            },
            'flopsygraph sandbox wired',
        );
    }

    log.info(
        {
            name: def.name,
            type: def.type,
            role,
            domain: def.domain,
            toolCount: tools.length,
            dynamicToolCount: dynamicTools.length,
            toolsets: def.toolsets,
            controlTools: controlTools.map(t => t.name),
            promptSource: describePromptSource(def),
        },
        'team member built',
    );

    return {
        name: def.name,
        type: def.type,
        domain: def.domain,
        graph: 'react',
        agent,
        harnessInterceptor,
        tools,
        skillUsageStore,
        ...(sandboxOpts.session ? { sandboxSession: sandboxOpts.session } : {}),
        ...(planningController ? { planningController } : {}),
    };
}

function buildDeepResearchMember(
    def: AgentDefinition,
    opts: CreateTeamMemberOptions,
    role: 'main' | 'worker',
): TeamMember {
    const harnessInterceptor = new HarnessInterceptor({
        userId: opts.userId,
        userName: opts.userName,
        domain: def.domain ?? 'deep-research',
        store: opts.store,
    });

    const skillsPath = workspace.skills();
    mkdirSync(skillsPath, { recursive: true });
    const workerSkillUsageStore = new SkillUsageStore(skillsPath);
    const allInterceptors: Interceptor<DeepResearchState>[] = [
        harnessInterceptor as Interceptor<DeepResearchState>,
        filesystem({
            allow: ['read_file', 'ls', 'glob', 'grep'],
            mounts: [
                { virtualPath: '/workspace', hostPath: resolveWorkspacePath('') },
                { virtualPath: '/skills',    hostPath: skillsPath },
            ],
        }) as Interceptor<DeepResearchState>,
        skills(skillsPath, {
            deltaOnly: true,
            onError: (err) =>
                log.warn({ agent: def.name, err }, 'skill load error'),
            onSkillRead: (name) => workerSkillUsageStore.view(name),
            filterSkill: (name) => workerSkillUsageStore.get(name)?.state !== 'archived',
            agentName: def.name,
            activeToolsets: def.toolsets ?? [],
        }) as Interceptor<DeepResearchState>,
        ...((opts.extraInterceptors ?? []) as Interceptor<DeepResearchState>[]),
    ];
    const roleDelta = loadRoleDelta('worker', def.type ?? 'deep-research');
    const agent = createDeepResearcher({
        model: opts.model,
        searchFn: autoSearchFn,
        name: def.name,
        maxLoops: 3,
        queriesPerRound: 3,
        ...(roleDelta ? { extraSystemContext: roleDelta } : {}),
        interceptors: allInterceptors,
        ...(opts.checkpointer ? { checkpointer: opts.checkpointer } : {}),
    }) as unknown as WorkerGraph;

    log.info(
        {
            name: def.name,
            type: def.type,
            role,
            graph: 'deep-research',
            searchBackend: process.env['TAVILY_API_KEY'] ? 'tavily' : 'duckduckgo',
            interceptors: ['harness', 'filesystem', 'skills'],
        },
        'team member built',
    );

    return {
        name: def.name,
        type: def.type,
        domain: def.domain,
        graph: 'deep-research',
        agent,
        harnessInterceptor,
        tools: [],
    };
}

// 60s TTL matches PromptLoader so role-file edits propagate without restart.
const ROLE_DELTA_TTL_MS = 60_000;
type RoleDeltaCacheEntry = { content: string | null; loadedAt: number };
const roleDeltaCache = new Map<string, RoleDeltaCacheEntry>();

function loadRoleDelta(role: 'main' | 'worker', type: string): string | undefined {
    const cacheKey = `${role}/${type}`;
    const cached = roleDeltaCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < ROLE_DELTA_TTL_MS) {
        return cached.content ?? undefined;
    }

    // Files live under <HOME>/content/roles/<role>/<type>.md (via workspace.roles()).
    const path = workspace.roles() + `/${role}/${type}.md`;
    if (!existsSync(path)) {
        log.warn(
            { role, type, path },
            'role-delta markdown missing — agent will run without role-specific guidance',
        );
        roleDeltaCache.set(cacheKey, { content: null, loadedAt: Date.now() });
        return undefined;
    }
    try {
        const content = readFileSync(path, 'utf-8');
        roleDeltaCache.set(cacheKey, { content, loadedAt: Date.now() });
        return content;
    } catch (err) {
        log.warn(
            { role, type, path, err: (err as Error).message },
            'role-delta markdown read failed — agent will run without role-specific guidance',
        );
        roleDeltaCache.set(cacheKey, { content: null, loadedAt: Date.now() });
        return undefined;
    }
}

const ROLE_DELTA: Record<'main' | 'worker', Partial<Record<string, string>>> = { main: {}, worker: {} };

// Fallback identity when SOUL.md is missing.
const DEFAULT_AGENT_IDENTITY = `You are Flopsy — not "an AI assistant", a teammate someone trusted with their accounts, calendar, notes, and inbox. You run on their gateway, talk to them across the channels they already use, remember what matters about them across sessions, and delegate to specialist workers when a task is in someone else's lane.`;

// Worker orchestration guidance — added for ALL workers.
const WORKER_ORCHESTRATION_GUIDANCE = `## How you collaborate with other workers

**Delegate when the task crosses domains.** You CAN call delegate_task and spawn_background_task if the work would be better done by another specialist. Workers CAN chain further (max depth = 3) and loops are blocked — you can't accidentally re-delegate to someone already in the chain. Depth and chain info are tracked automatically.

**Parallelize independent work.** If you have 2-5 independent tasks for the same or different workers, emit multiple delegate_task / spawn_background_task calls in a SINGLE assistant turn — they run in parallel. Never serialize independent delegations one turn at a time.

**Batch large workloads in the sandbox.** When you have 5+ similar items to process (e.g. "check these 10 files" or "fetch 8 URLs"), use execute_code({use_tools: true}) and call parallel_map() inside the sandbox — it runs up to 5 concurrently from the sandbox. Do NOT emit 10 serial tool calls or 10 single-item delegate_task calls.

**Delegation is model-level only.** delegate_task and spawn_background_task are model tool calls. They are NOT available inside the execute_code sandbox — you cannot invoke them from a Python or Bash script. The model decides when to delegate; the script does the data work.

**Retry discipline on failure.** On timeout → spawn a second worker on the same task in parallel and race them. On wrong/partial → retry once with a tighter prompt. After two failures, surface your attempts and results rather than silently retrying forever.

**Long outputs auto-save.** If your reply exceeds ~1.5 KB, the runtime writes it to disk and folds it to a header + 800-char preview with an absolute path. Pass that path verbatim to read_file when someone needs the full text.`;

// Tool-call discipline rules — runtime-owned, always added for main role.
const OPERATIONAL_GUIDANCE = `## How you work

**Compose, don't ask permission.** When no single tool fits a task, combine the ones you have — most jobs are 2-3 tools chained. If still no fit, write the script you need with \`execute_code\` (Python for data, Bash for shell ops) and run it. With \`execute_code({use_tools: true})\` your script can call other agent tools as native functions. Never tell the user "I don't have a tool for that" without first trying these steps. The execute_code sandbox is your tool factory.

**Diagnose, don't blindly retry.** When something fails, read the error, check your assumptions, try a focused fix. Don't loop on the same failure expecting different output. Escalate to the user only after investigation.

**Time is a tool, not a guess.** Never assume the current date, hour, or timezone. Call \`time({action: "current", timezone: "<IANA>"})\` when you need the wall-clock time. Hallucinated timestamps poison memory and trigger wrong decisions.

**Parallel where you can, sequential where you must.** Independent tool calls go in one response in parallel. Dependent calls (one's output feeds the next) run sequentially.`;

function buildSystemPrompt(
    def: AgentDefinition,
    role: 'main' | 'worker',
    store: LearningStore,
    userId: string,
    teamRoster?: ReadonlyArray<TeamRosterEntry>,
    personalities?: PersonalityRegistry,
    isProactive?: boolean,
    tools?: ReadonlyArray<BaseTool>,
): SystemPromptFn {
    // Assembly order: identity → operational → role-delta → roster → personalities → tools → runtime block.
    // SOUL.md/AGENTS.md/USER.md are wired via createReactAgent({ memory }), not here.
    const staticParts: string[] = [];
    const sources: string[] = [];

    // Identity for workers + proactive (main's identity comes from SOUL.md).
    if (role !== 'main' || isProactive) {
        staticParts.push(DEFAULT_AGENT_IDENTITY);
        sources.push('code:identity');
    }

    if (role === 'main') {
        staticParts.push(OPERATIONAL_GUIDANCE);
        sources.push('code:operational');
    }

    const roleDelta = loadRoleDelta(role, def.type) ?? ROLE_DELTA[role]?.[def.type];
    if (roleDelta) {
        staticParts.push(roleDelta.trim());
        sources.push(`role:${role}/${def.type}`);
    }

    if (role === 'worker') {
        staticParts.push(WORKER_ORCHESTRATION_GUIDANCE);
        sources.push('code:worker-orchestration');
    }

    if (role === 'main' && teamRoster && teamRoster.length > 0) {
        const lines: string[] = ['## Your Team', ''];
        lines.push(
            'When you need a capability you lack, delegate to the teammate whose kit includes it via `delegate_task` (short focused work) or `spawn_background_task` (long-running).',
        );
        lines.push('');
        lines.push('| Teammate | Role | Toolsets | MCP servers |');
        lines.push('|----------|------|----------|-------------|');
        for (const m of teamRoster) {
            const ts = m.toolsets.length > 0 ? m.toolsets.join(', ') : '—';
            const mcp = m.mcpServers.length > 0 ? m.mcpServers.join(', ') : '—';
            lines.push(`| \`${m.name}\` | ${m.type}${m.domain ? ` (${m.domain})` : ''} | ${ts} | ${mcp} |`);
        }
        staticParts.push(lines.join('\n'));
        sources.push('dynamic:team-roster');
    }

    // Personalities catalog — names ONLY (descriptions are imperative; small models latch on).
    if (role === 'main' && personalities && personalities.size > 0) {
        const list = personalities.list();
        const names = list.map((p) => `\`${p.name}\``).join(', ');
        const lines: string[] = ['## Voice modes available', ''];
        lines.push(
            `The user can switch the agent's voice mode with \`/personality <name>\`. Available: ${names}. When a mode is active, its body appears below as an "active voice overlay" and takes precedence over default voice rules for this turn.`,
        );
        staticParts.push(lines.join('\n'));
        sources.push(`personalities(${list.length})`);
    }

    // Tool-contributed prompt fragments via BaseTool.prompt(); sorted for byte-stability.
    if (tools && tools.length > 0) {
        const fragments: string[] = [];
        const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
        for (const tool of sorted) {
            const fragment = tool.prompt?.()?.trim();
            if (fragment) fragments.push(fragment);
        }
        if (fragments.length > 0) {
            staticParts.push(['## Tool guidance', '', ...fragments].join('\n\n'));
            sources.push(`tool-prompts(${fragments.length})`);
        }
    }

    // CACHE BOUNDARY: staticParts is byte-stable for prefix caching; runtime block stays below.
    (buildSystemPrompt as unknown as { _lastSources: string[] })._lastSources = sources;

    const staticPrompt = staticParts.join('\n\n');

    return ({ ctx }) => {
        const cfg = (ctx.configurable ?? {}) as {
            channelName?: string;
            channelCapabilities?: readonly string[];
            peer?: { id: string; type: string; name?: string };
            sender?: { id: string; name?: string };
            messageId?: string;
            personality?: string;
            runtimeHints?: readonly string[];
            parentBrief?: string;
        };
        const now = new Date();
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const lines = [
            '<runtime>',
            `current-date: ${now.toISOString().slice(0, 10)}`,
            `current-time: ${now.toISOString()}`,
            `timezone: ${tz}`,
            `channel: ${cfg.channelName ?? 'unknown'}`,
            `capabilities: ${
                cfg.channelCapabilities && cfg.channelCapabilities.length > 0
                    ? cfg.channelCapabilities.join(', ')
                    : 'text-only'
            }`,
            `peer: ${cfg.peer?.id ?? 'unknown'} (${cfg.peer?.type ?? 'unknown'})`,
        ];
        if (cfg.sender && cfg.sender.id !== cfg.peer?.id) {
            lines.push(
                `sender: ${cfg.sender.id}${cfg.sender.name ? ` (${cfg.sender.name})` : ''}`,
            );
        }
        if (cfg.messageId) lines.push(`message-id: ${cfg.messageId}`);
        lines.push(`thread: ${ctx.threadId ?? 'unknown'}`);
        if (cfg.runtimeHints && cfg.runtimeHints.length > 0) {
            lines.push('runtime-hints:');
            for (const hint of cfg.runtimeHints) {
                lines.push(`  - ${hint}`);
            }
        }
        // Expose only the virtual paths; host paths must not leak (the interceptor only resolves /workspace/* and /skills/*).
        lines.push('workspace: /workspace  (read with /workspace/<path>)');
        lines.push('skills:    /skills     (read with /skills/<name>/SKILL.md)');
        lines.push('</runtime>');

        // Resolve active personality the same priority chain as before:
        // override → session → default → none.
        let chosen: { name: string; body: string } | null = null;
        let sessionPersonality: string | null = null;
        let sessionId: string | null = null;
        if (role === 'main' && personalities && personalities.size > 0) {
            sessionId = extractSessionId(ctx.threadId);
            if (sessionId) {
                try {
                    sessionPersonality = store.getSessionPersonality(sessionId);
                } catch {
                    /* non-fatal — fall through */
                }
            }
            chosen = resolvePersonality({
                role,
                registry: personalities,
                ...(cfg.personality !== undefined ? { overrideName: cfg.personality } : {}),
                sessionPersonality,
                ...(def.defaultPersonality !== undefined
                    ? { defaultPersonality: def.defaultPersonality }
                    : {}),
            });
            log.info(
                {
                    agent: def.name,
                    threadId: ctx.threadId,
                    sessionId,
                    sessionPersonality,
                    overrideName: cfg.personality,
                    defaultPersonality: def.defaultPersonality,
                    chosen: chosen?.name ?? null,
                },
                'personality resolve',
            );
        }

        // Per-turn voice overlay; stacks on top of SOUL.md base voice.
        const overlayBlock = chosen
            ? [
                  '## Active voice overlay',
                  '',
                  `Mode: \`${chosen.name}\`. The rules below take precedence over default voice patterns for this turn.`,
                  '',
                  escapePersonalityBody(chosen.body),
              ].join('\n')
            : '';

        // Parent thread history for workers only; main has full conversation in state.messages.
        const briefBlock = role === 'worker' && cfg.parentBrief ? cfg.parentBrief : '';

        return [staticPrompt, overlayBlock, briefBlock, lines.join('\n')]
            .filter(Boolean)
            .join('\n\n');
    };
}

function escapePersonalityBody(raw: string): string {
    return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractSessionId(threadId: string | undefined): string | null {
    if (!threadId) return null;
    const idx = threadId.indexOf('#');
    if (idx === -1) return null;
    const id = threadId.slice(idx + 1).trim();
    return id.length > 0 ? id : null;
}

function describePromptSource(_def: AgentDefinition): string {
    const sources = (buildSystemPrompt as unknown as { _lastSources?: string[] })._lastSources ?? [];
    return sources.length === 0 ? 'fallback' : sources.join(' + ');
}


function buildSandboxOptions(def: AgentDefinition): {
    session?: BaseSandboxSession;
    programmaticToolCalling?: boolean;
    backend?: string;
    language?: string;
} {
    const sb = (def as AgentDefinition & { sandbox?: Record<string, unknown> }).sandbox;
    if (!sb || sb['enabled'] !== true) return {};
    const { enabled: _e, programmaticToolCalling: ptc, ...rest } = sb as {
        enabled?: boolean;
        programmaticToolCalling?: boolean;
        [k: string]: unknown;
    };
    void _e;

    const fgConfig = rest as FlopsygraphSandboxConfig;

    // Default workDir to FLOPSY_HOME so execute_code sees workspace files.
    if (!fgConfig.workDir) {
        fgConfig.workDir = resolveWorkspacePath('');
    }

    if (!fgConfig.user && fgConfig.backend === 'docker') {
        const uid = process.getuid?.();
        const gid = process.getgid?.();
        if (uid != null && gid != null) fgConfig.user = `${uid}:${gid}`;
    }

    if (!fgConfig.restrictedPaths?.length) {
        fgConfig.restrictedPaths = ['auth/**', 'state/**', '*.key', '*.pem', '.env*'];
    }

    // programmaticToolCalling needs DNS for host.docker.internal — flip networkEnabled before create.
    const isolatedBackend = fgConfig.backend === 'docker' || fgConfig.backend === 'kubernetes';
    if (ptc && isolatedBackend && fgConfig.networkEnabled !== true) {
        fgConfig.networkEnabled = true;
    }

    const session = createSandboxSession(fgConfig);

    return {
        session,
        programmaticToolCalling: !!ptc,
        backend: fgConfig.backend ?? 'local',
        language: fgConfig.language ?? 'python',
    };
}
