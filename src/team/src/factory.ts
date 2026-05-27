import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import type { ZodType } from 'zod';
import {
    autoSearchFn,
    createDeepResearcher,
    createReactAgent,
    filesystem,
    humanApproval,
    injectContext,
    messageQueue,
    modelFallback,
    promptShield,
    skills,
    createSkillTool,
    webCrawlTool,
    weatherTool,
    timeTool,
    hackerNewsTool,
    newsTool,
    arxivTool,
    wikipediaTool,
    calculatorTool,
    geocodeTool,
    yahooFinanceTool,
    cryptoTool,
    currencyTool,
    todoList,
    RetryModel,
    createSession as createSandboxSession,
    BaseSandboxSession,
} from 'flopsygraph';
import type {
    BaseTool,
    BaseChatModel,
    MemoryProvider,
    ChatMessage,
    CheckpointStore,
    CompiledGraph,
    DeepResearchState,
    Interceptor,
    InterceptorContext,
    ModelFallbackOptions,
    ModelRef,
    SandboxConfig as FlopsygraphSandboxConfig,
    SystemPromptFn,
} from 'flopsygraph';
import type { AgentDefinition } from '@flopsy/shared';
import {
    createLogger,
    resolveWorkspacePath,
    workspace,
    channelCapabilityHint,
    channelGuidance,
    modelFamily,
    hostInfo,
} from '@flopsy/shared';
import {
    createMemoryTool,
    getMemoryFilePaths,
    DEFAULT_USER_CHAR_LIMIT,
    DEFAULT_MEMORY_CHAR_LIMIT,
} from './memory';
import {
    HarnessInterceptor,
    toolLoopDedup,
    sanitizeToolCallNoise,
    reflectionNudge,
    userLearningNudge,
} from './harness';
import type { LearningStore } from './harness';
import { SkillUsageStore } from './harness/review';
import type { PersonalityRegistry } from './personalities';
import { resolvePersonality } from './personalities';
import { substituteAgentRefs } from './utils/agent-name-substitution';
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
import { planTool, loadPlanForThread } from './tools/plan';
import { handoffTaskTool } from './tools/handoff-task';
import { codeAgentTool } from './tools/code-agent';
import { modelFamilyOverlay } from './model-overlays';
import { MEMORY_GUIDANCE } from './prompts/memory-guidance';

const AGENTS_MD_SECTION_GATES: Record<string, readonly string[]> = {
    'Memory pointer': ['memory'],
    'Authentication — `connect_service` triggers': ['connect_service'],
    'Composing tools — write a script when no tool fits': ['execute_code'],
    Delegation: ['delegate_task', 'spawn_background_task'],
    'Scheduling reminders — `manage_schedule`': ['manage_schedule'],
    'Error recovery — delegate or run a script': [
        'delegate_task',
        'spawn_background_task',
        'execute_code',
    ],
    'Programmatic tool calling — when to reach for it': ['execute_code'],
    'Skills — scan, load, proceed': ['skill_manage'],
    'Track your work — `write_todos`': ['write_todos'],
};

function filterAgentsMdByTools(raw: string, toolNames: Set<string>): string {
    if (!raw.trim()) return '';
    const lines = raw.split('\n');
    type Section = { title: string | null; body: string[] };
    const sections: Section[] = [{ title: null, body: [] }];
    for (const line of lines) {
        if (line.startsWith('## ')) {
            sections.push({ title: line.slice(3).trim(), body: [line] });
        } else {
            sections[sections.length - 1]!.body.push(line);
        }
    }
    const kept: string[] = [];
    for (const sec of sections) {
        if (sec.title === null) {
            const body = sec.body.join('\n').trimEnd();
            if (body) kept.push(body);
            continue;
        }
        const requiredTools = AGENTS_MD_SECTION_GATES[sec.title];
        if (!requiredTools || requiredTools.some((t) => toolNames.has(t))) {
            kept.push(sec.body.join('\n').trimEnd());
        }
    }
    return kept.join('\n\n').trim();
}

const log = createLogger('team-factory');

const US_IMPERIAL_TZ = new Set([
    'America/New_York', 'America/Detroit', 'America/Kentucky/Louisville', 'America/Kentucky/Monticello',
    'America/Indiana/Indianapolis', 'America/Indiana/Vincennes', 'America/Indiana/Winamac',
    'America/Indiana/Marengo', 'America/Indiana/Petersburg', 'America/Indiana/Vevay',
    'America/Indiana/Tell_City', 'America/Indiana/Knox',
    'America/Chicago', 'America/Menominee', 'America/North_Dakota/Center',
    'America/North_Dakota/New_Salem', 'America/North_Dakota/Beulah',
    'America/Denver', 'America/Boise',
    'America/Phoenix',
    'America/Los_Angeles',
    'America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Metlakatla',
    'America/Yakutat', 'America/Nome', 'America/Adak',
    'Pacific/Honolulu',
]);

import { EventEmitter } from 'node:events';
import type {
    BaseChatModel as _BaseChatModel,
    CompactorAccessors,
    CompactorCheck,
    CompactionEvent,
} from 'flopsygraph';
import type { ChatMessage as _ChatMessage } from 'flopsygraph';
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from 'flopsygraph';
import {
    buildWorkerOrchestrationGuidance,
    buildOperationalGuidance,
    buildNotificationFormatGuidance,
} from './factory/prompt-blocks';

const compactorRegistry = new Map<string, CompactorAccessors>();

export function getCompactorStatus(
    agentName: string,
    threadId: string,
): CompactorCheck | undefined {
    return compactorRegistry.get(agentName)?.getLastCheck(threadId);
}

export const compactionEvents = new EventEmitter();
compactionEvents.setMaxListeners(0);
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
    readonly memoryStore?: MemoryProvider;
    readonly teamRoster?: ReadonlyArray<TeamRosterEntry>;
    /**
     * Name of the agent with `role: 'main'`. Used by the placeholder layer
     * to resolve `${main}` references in role-deltas + skill bodies. If
     * unset, `${main}` remains unsubstituted (visible to the model as a
     * tell — better than silently wrong).
     */
    readonly mainAgentName?: string;
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
    /** Sharp delegation trigger (from `def.whenToUse`); falls back to `domain`. */
    readonly whenToUse?: string;
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
    readonly skillUsageStore?: SkillUsageStore;
    readonly interceptors: ReadonlyArray<Interceptor>;
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

    const skillTool = createSkillTool({ skillsPath: workspace.skills() });
    // Memory tools come from the registry-loaded provider (opts.memoryStore)
    // when the handler routed through flopsygraph's memory registry. Fall back
    // to direct file-tool construction if no provider was supplied (keeps older
    // call paths and tests working unchanged).
    const memoryTools: BaseTool[] = opts.memoryStore
        ? [...opts.memoryStore.getTools()]
        : (() => {
              const paths = getMemoryFilePaths();
              return [
                  createMemoryTool({
                      userPath: paths.user,
                      memoryPath: paths.memory,
                      userCharLimit: opts.memoryCharLimits?.user ?? DEFAULT_USER_CHAR_LIMIT,
                      memoryCharLimit: opts.memoryCharLimits?.memory ?? DEFAULT_MEMORY_CHAR_LIMIT,
                  }),
              ];
          })();
    const universalTools: BaseTool[] = [
        skillTool,
        webCrawlTool,
        weatherTool,
        timeTool,
        hackerNewsTool,
        newsTool,
        arxivTool,
        wikipediaTool,
        calculatorTool,
        geocodeTool,
        yahooFinanceTool,
        cryptoTool,
        currencyTool,
        ...memoryTools,
    ];
    const declaredTools = resolveToolsets(def.toolsets ?? []);
    const seen = new Set<BaseTool>();
    const baseTools: BaseTool[] = [];
    for (const t of [...universalTools, ...declaredTools, ...(opts.extraTools ?? [])]) {
        if (!seen.has(t)) {
            seen.add(t);
            baseTools.push(t);
        }
    }

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
        'plan',
        'code_agent',
    ]);

    const controlTools: BaseTool[] = (() => {
        if (role !== 'main')
            return [delegateTaskTool, spawnBackgroundTaskTool, handoffTaskTool, notifyTeammateTool, skillManageTool];

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
            planTool,
            codeAgentTool,
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
        opts.mainAgentName,
    );

    const harnessInterceptor = new HarnessInterceptor({
        userId: opts.userId,
        userName: opts.userName,
        domain: def.domain,
        store: opts.store,
    });

    const interceptors: Interceptor[] = [harnessInterceptor];

    interceptors.push(
        promptShield({
            onInjection: 'rewrite',
            onUnicode: 'strip',
            scanRoles: ['user', 'tool'],
            onEvent: (ev: import('flopsygraph').PromptShieldEvent) => {
                if (ev.type === 'unicode-stripped') {
                    log.warn(
                        {
                            role: ev.role,
                            threadId: ev.threadId,
                            before: ev.sourceLength,
                            after: ev.sanitizedLength,
                        },
                        'prompt-shield: unicode stripped',
                    );
                } else if (ev.type === 'injection-detected') {
                    log.warn(
                        { role: ev.role, pattern: ev.pattern, threadId: ev.threadId },
                        'prompt-shield: injection pattern matched — rewrote as untrusted_content',
                    );
                } else if (ev.type === 'blocked') {
                    log.error(
                        { role: ev.role, pattern: ev.pattern, threadId: ev.threadId },
                        'prompt-shield: BLOCKED model call',
                    );
                }
            },
        }),
    );
    interceptors.push(toolLoopDedup());
    interceptors.push(sanitizeToolCallNoise());
    interceptors.push(reflectionNudge());

    if (role === 'main' && !opts.isProactive) {
        interceptors.push(userLearningNudge());
    }

    // CorrectionInterceptor removed: corrections used to land in memory.db namespaces,
    // but the agent now writes to .md files via the `memory` tool — no SQL consumer.

    if (def.fallback_models?.length) {
        // Preserve per-fallback `config` so fallback model settings reach the built model.
        const fallbacks = def.fallback_models.map(
            (m) =>
                ({
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
                allow: ['read_file', 'ls', 'glob', 'grep', 'write_file', 'edit_file'],
                mounts: [
                    { virtualPath: '/workspace', hostPath: resolveWorkspacePath(''), readOnly: true },
                    { virtualPath: '/skills', hostPath: workspace.skills(), readOnly: true },
                    { virtualPath: '/memory', hostPath: getMemoryFilePaths().dir, readOnly: true },
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
            deltaOnly: false,
            onError: (err) => log.warn({ agent: def.name, err }, 'skill load error'),
            onSkillRead: (name) => skillUsageStore.view(name),
            filterSkill: (name) => skillUsageStore.get(name)?.state !== 'archived',
            // Per-agent filtering via `agent-affinity` and `requires_toolsets` metadata.
            agentName: def.name,
            activeToolsets: def.toolsets ?? [],
            // Relevance-rank when the catalog is large. Top-12 covers all
            // realistic per-turn needs; bundled-equivalents pull peers in.
            // Falls back to standard delta on short/empty queries (greetings).
            relevanceTopK: 12,
            recencyBonus: (name: string) => {
                const r = skillUsageStore.get(name);
                if (!r) return 0;
                let bonus = Math.min(3, (r.view_count ?? 0) / 5);
                if (r.pinned) bonus += 2;
                return bonus;
            },
        }),
    );

    interceptors.push(todoList());

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

    const compactorInst = compactor({
        getContextWindow: defaultContextWindowFor,
        summarize: (msgs) => summarizeForCompaction(opts.model, msgs),
        onCompact: async (event) => {
            compactionEvents.emit('compaction', { ...event, agentName: def.name });
            const ctx: InterceptorContext = {
                runId: `compact-${def.name}-${Date.now()}`,
                threadId: event.threadId,
                configurable: {},
                store: new Map<string, unknown>(),
            };
            for (const i of interceptors) {
                if (i === compactorInst) continue;
                if (!i.onCompact) continue;
                try { await i.onCompact(event, ctx); } catch { /* */ }
            }
        },
        onPreCompress: async (messages) => {
            const insights: string[] = [];
            const ctx: InterceptorContext = {
                runId: `pre-compress-${def.name}-${Date.now()}`,
                threadId: def.name,
                configurable: {},
                store: new Map<string, unknown>(),
            };
            for (const i of interceptors) {
                if (i === compactorInst) continue;
                if (!i.onPreCompress) continue;
                try {
                    const r = await i.onPreCompress(messages, ctx);
                    if (typeof r === 'string' && r.trim()) insights.push(r.trim());
                } catch {
                    /* */
                }
            }
            return insights.join('\n---\n');
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
    const hasMeaningfulContent = (path: string): boolean => {
        if (!existsSync(path)) return false;
        try {
            const body = readFileSync(path, 'utf8').replace(/^#[^\n]*\n?/, '').trim();
            return body.length > 0;
        } catch {
            return false;
        }
    };
    const memoryPaths = getMemoryFilePaths();
    const memoryStateFiles = [
        { hostPath: memoryPaths.user,   virtualLabel: '/memory/USER.md', scan: true },
        { hostPath: memoryPaths.memory, virtualLabel: '/memory/MEMORY.md', scan: true },
    ].filter((m) => hasMeaningfulContent(m.hostPath));
    const memoryFiles: Array<string | { hostPath: string; virtualLabel?: string }> = (() => {
        if (role === 'main') {
            return [
                { hostPath: workspace.config('SOUL.md'), virtualLabel: '/workspace/config/SOUL.md' },
                ...memoryStateFiles,
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
        model: new RetryModel(opts.model, {
            maxRetries: retryMax,
            baseDelayMs: 1000,
            maxDelayMs: 30_000,
        }),
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
        useMemory: false,
        ...(opts.modelCallTimeoutMs !== undefined
            ? { modelCallTimeoutMs: opts.modelCallTimeoutMs }
            : {}),
        ...(sandboxOpts.session ? { sandbox: sandboxOpts.session } : {}),
        ...(sandboxOpts.programmaticToolCalling ? { programmaticToolCalling: true } : {}),
        ...(sandboxOpts.session ? { bashTool: true } : {}),
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
                networkEnabled: (
                    sandboxOpts.session as unknown as { config?: { networkEnabled?: boolean } }
                ).config?.networkEnabled,
                hardened: (sandboxOpts.session as unknown as { config?: { hardened?: boolean } })
                    .config?.hardened,
                untrusted: (sandboxOpts.session as unknown as { config?: { untrusted?: boolean } })
                    .config?.untrusted,
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
            controlTools: controlTools.map((t) => t.name),
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
        interceptors,
        ...(sandboxOpts.session ? { sandboxSession: sandboxOpts.session } : {}),
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
            allow: ['read_file', 'ls', 'glob', 'grep', 'write_file', 'edit_file'],
            mounts: [
                { virtualPath: '/workspace', hostPath: resolveWorkspacePath(''), readOnly: true },
                { virtualPath: '/skills', hostPath: skillsPath, readOnly: true },
                { virtualPath: '/memory', hostPath: getMemoryFilePaths().dir, readOnly: true },
            ],
        }) as Interceptor<DeepResearchState>,
        skills(skillsPath, {
            deltaOnly: false,
            onError: (err) => log.warn({ agent: def.name, err }, 'skill load error'),
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
        interceptors: [],
    };
}

// 60s TTL matches PromptLoader so role-file edits propagate without restart.
const ROLE_DELTA_TTL_MS = 60_000;
type RoleDeltaCacheEntry = { content: string | null; loadedAt: number };
const roleDeltaCache = new Map<string, RoleDeltaCacheEntry>();

/**
 * Load a per-agent custom prompt file. ALWAYS resolves inside FLOPSY_HOME
 * (the workspace) — absolute paths and path-traversal (`..`) escapes are
 * rejected. This keeps custom prompts version-controllable with the rest
 * of the workspace and prevents an agent's prompt from pointing at
 * arbitrary host files (security + portability).
 *
 * Caches under the same TTL as role-delta so file edits propagate without
 * restart. Returns undefined + warns when missing/invalid — caller falls
 * back to the type-based role-delta, so a typo doesn't kill the agent.
 *
 * Conventional location: `.flopsy/content/roles/<custom-name>.md` or
 * `.flopsy/content/prompts/agents/<name>.md`. Anywhere under FLOPSY_HOME
 * works as long as the path is relative.
 */
function loadCustomPromptFile(promptPath: string, agentName: string): string | undefined {
    // Reject absolute paths (UNIX or Windows) — every prompt MUST live in the
    // workspace so it's owned + portable + auditable alongside flopsy.json5.
    if (promptPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(promptPath) || promptPath.startsWith('~')) {
        log.warn(
            { agent: agentName, promptPath },
            'agent.promptPath: absolute paths rejected — use a path relative to FLOPSY_HOME (e.g. "content/roles/custom.md")',
        );
        return undefined;
    }

    const home = workspace.root();
    const resolved = resolvePath(home, promptPath);
    // Defense-in-depth: ensure the resolved absolute path is still inside
    // FLOPSY_HOME (catches `..` traversal that survived join). Use a trailing
    // separator on the home prefix so `/foo/.flopsy` ≠ `/foo/.flopsy-attacker`.
    const homeWithSep = home.endsWith('/') ? home : home + '/';
    if (resolved !== home && !resolved.startsWith(homeWithSep)) {
        log.warn(
            { agent: agentName, promptPath, resolved, home },
            'agent.promptPath: path escapes FLOPSY_HOME via `..` — rejected',
        );
        return undefined;
    }

    const cacheKey = `custom:${resolved}`;
    const cached = roleDeltaCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < ROLE_DELTA_TTL_MS) {
        return cached.content ?? undefined;
    }

    if (!existsSync(resolved)) {
        log.warn(
            { agent: agentName, promptPath, resolved },
            'agent.promptPath: file not found in workspace — falling back to role-delta',
        );
        roleDeltaCache.set(cacheKey, { content: null, loadedAt: Date.now() });
        return undefined;
    }
    try {
        const content = readFileSync(resolved, 'utf-8');
        roleDeltaCache.set(cacheKey, { content, loadedAt: Date.now() });
        log.info(
            { agent: agentName, promptPath, resolved, bytes: content.length },
            'agent.promptPath: loaded custom prompt from workspace',
        );
        return content;
    } catch (err) {
        log.warn(
            { agent: agentName, promptPath, resolved, err: (err as Error).message },
            'agent.promptPath: read failed — falling back to role-delta',
        );
        roleDeltaCache.set(cacheKey, { content: null, loadedAt: Date.now() });
        return undefined;
    }
}

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

const ROLE_DELTA: Record<'main' | 'worker', Partial<Record<string, string>>> = {
    main: {},
    worker: {},
};

interface SkillOwnershipEntry {
    name: string;
    whenToUse?: string;
}

interface WorkerOutputEntry {
    file: string;
    worker: string;
    topic: string;
    mtimeMs: number;
    sizeBytes: number;
}

const WORKER_OUTPUTS_MAX_ROWS = 20;
const WORKER_OUTPUTS_TTL_MS = 30_000;
let workerOutputsCache: { loadedAt: number; rows: WorkerOutputEntry[]; total: number } | null = null;

function loadWorkerOutputs(dir: string): { rows: WorkerOutputEntry[]; total: number } {
    if (workerOutputsCache && Date.now() - workerOutputsCache.loadedAt < WORKER_OUTPUTS_TTL_MS) {
        return { rows: workerOutputsCache.rows, total: workerOutputsCache.total };
    }
    if (!existsSync(dir)) {
        workerOutputsCache = { loadedAt: Date.now(), rows: [], total: 0 };
        return { rows: [], total: 0 };
    }
    let entries: string[];
    try { entries = readdirSync(dir); }
    catch { return { rows: [], total: 0 }; }

    const all: WorkerOutputEntry[] = [];
    for (const name of entries) {
        if (!name.endsWith('.md')) continue;
        const full = join(dir, name);
        let stat;
        try { stat = statSync(full); }
        catch { continue; }
        if (!stat.isFile()) continue;
        const base = name.slice(0, -3);
        let worker = '?';
        let topic = base;
        const newForm = base.split('__');
        if (newForm.length === 3) {
            worker = newForm[0]!;
            topic = newForm[1]!.replace(/-/g, ' ');
        } else {
            const legacy = base.match(/^(20\d{2}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([a-z0-9]+)-(.+)$/);
            if (legacy) {
                worker = legacy[2]!;
                topic = legacy[3]!.replace(/-/g, ' ');
            }
        }
        all.push({ file: name, worker, topic, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    }
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const rows = all.slice(0, WORKER_OUTPUTS_MAX_ROWS);
    workerOutputsCache = { loadedAt: Date.now(), rows, total: all.length };
    return { rows, total: all.length };
}

function formatRelativeTime(ms: number): string {
    const dt = Date.now() - ms;
    if (dt < 0) return 'now';
    const min = Math.floor(dt / 60_000);
    if (min < 1) return 'now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 48) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 14) return `${day}d ago`;
    const wk = Math.floor(day / 7);
    return `${wk}w ago`;
}

function formatSizeKB(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    const kb = bytes / 1024;
    if (kb < 100) return `${kb.toFixed(1)} KB`;
    return `${Math.round(kb)} KB`;
}

const SKILL_OWNERSHIP_TTL_MS = 5 * 60 * 1000;
let skillOwnershipCache: { loadedAt: number; data: Record<string, SkillOwnershipEntry[]> } | null = null;

/**
 * Scan the skills directory and return a map of `worker → owned skills`.
 *
 * "Owned" means the skill's `agent-affinity` frontmatter lists exactly that
 * worker name (not `*`, not multiple workers). Skills tagged for ALL agents
 * (`[*]`) or multiple workers are excluded — they're not a routing signal
 * for the delegator.
 *
 * This exists because the per-agent affinity filter in the skills
 * interceptor hides worker-tagged skills from the delegator's catalog.
 * Without surfacing them in the system prompt some other way, the
 * delegator (gandalf) has no path to learn "worker X owns capability Y".
 */
function loadSkillOwnership(
    skillsPath: string,
    workerNames: string[],
): Record<string, SkillOwnershipEntry[]> {
    if (skillOwnershipCache && Date.now() - skillOwnershipCache.loadedAt < SKILL_OWNERSHIP_TTL_MS) {
        return skillOwnershipCache.data;
    }
    const out: Record<string, SkillOwnershipEntry[]> = {};
    if (!existsSync(skillsPath)) {
        skillOwnershipCache = { loadedAt: Date.now(), data: out };
        return out;
    }
    const workerSet = new Set(workerNames);

    // Process a single SKILL.md → push entry into `out[owner]` if it has a
    // valid single-worker agent-affinity. Reused for both flat and grouped
    // layouts.
    const processSkillFile = (skillFile: string, dirName: string): void => {
        let raw: string;
        try { raw = readFileSync(skillFile, 'utf-8'); }
        catch { return; }
        if (!raw.startsWith('---')) return;
        const close = raw.indexOf('\n---', 3);
        if (close === -1) return;
        const fm = raw.slice(3, close);
        const affMatch = fm.match(/agent-affinity:\s*\[([^\]]*)\]/);
        if (!affMatch) return;
        const targets = affMatch[1]!
            .split(',')
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
        if (targets.includes('*')) return;
        if (targets.length !== 1) return;
        const owner = targets[0]!;
        if (!workerSet.has(owner)) return;
        const nameMatch = fm.match(/^name:\s*([^\n]+)/m);
        const name = nameMatch?.[1]?.trim() ?? dirName;
        const wtuMatch = fm.match(/^when[_-]to[_-]use:\s*"?([^"\n]+)"?/m);
        const whenToUse = wtuMatch?.[1]?.trim().replace(/^["']|["']$/g, '');
        if (!out[owner]) out[owner] = [];
        out[owner].push(whenToUse ? { name, whenToUse } : { name });
    };

    // Walks BOTH flat (skills/<name>/SKILL.md) and grouped
    // (skills/<group>/<name>/SKILL.md) layouts.
    let entries: string[] = [];
    try { entries = readdirSync(skillsPath); }
    catch { return out; }
    for (const entry of entries) {
        const entryPath = join(skillsPath, entry);
        const flat = join(entryPath, 'SKILL.md');
        if (existsSync(flat)) {
            processSkillFile(flat, entry);
            continue;
        }
        // Treat as group — scan one level deeper.
        let subs: string[];
        try { subs = readdirSync(entryPath); }
        catch { continue; }
        for (const sub of subs) {
            const subSkill = join(entryPath, sub, 'SKILL.md');
            if (existsSync(subSkill)) processSkillFile(subSkill, sub);
        }
    }
    for (const k of Object.keys(out)) {
        out[k].sort((a, b) => a.name.localeCompare(b.name));
    }
    skillOwnershipCache = { loadedAt: Date.now(), data: out };
    return out;
}

// Fallback identity when SOUL.md is missing.
const DEFAULT_AGENT_IDENTITY = `You are Flopsy — not "an AI assistant", a teammate someone trusted with their accounts, calendar, notes, and inbox. You run on their gateway, talk to them across the channels they already use, remember what matters about them across sessions, and delegate to specialist workers when a task is in someone else's lane.`;

// Document-level priority chain: when two blocks in this prompt disagree,
// the higher-numbered (more specific / more recent) source wins. Blocks are
// ordered for prefix-cache stability, not authority — this resolves that.
const SOURCE_PRIORITY_GUIDANCE = `## Source priority (when blocks disagree)

1. current user instruction (this turn)
2. active personality overlay (if any)
3. SOUL.md — voice
4. AGENTS.md — operating principles
5. role file (main.md / proactive.md / worker role-delta) — role-specific
6. tool descriptions — interface contracts
7. model-family overlay — provider quirks

when in doubt, the more specific wins.`;


function buildSystemPrompt(
    def: AgentDefinition,
    role: 'main' | 'worker',
    store: LearningStore,
    userId: string,
    teamRoster?: ReadonlyArray<TeamRosterEntry>,
    personalities?: PersonalityRegistry,
    isProactive?: boolean,
    tools?: ReadonlyArray<BaseTool>,
    mainAgentName?: string,
): SystemPromptFn {
    // Assembly order: identity → operational → role-delta → roster → personalities → tools → runtime block.
    // SOUL.md/AGENTS.md/USER.md are wired via createReactAgent({ memory }), not here.
    const staticParts: string[] = [];
    const sources: string[] = [];
    const toolNameSet = new Set((tools ?? []).map((t) => t.name));
    const hasMemoryTool = toolNameSet.has('memory');

    // Identity for workers + proactive (main's identity comes from SOUL.md).
    if (role !== 'main' || isProactive) {
        staticParts.push(DEFAULT_AGENT_IDENTITY);
        sources.push('code:identity');
    }

    // Document-level priority chain — injected for main (non-proactive) and
    // workers. Proactive fires skip it: the proactive role-delta is tight and
    // there is no live user instruction / personality to rank.
    if (!isProactive) {
        staticParts.push(SOURCE_PRIORITY_GUIDANCE);
        sources.push('code:source-priority');
    }

    if (role === 'main') {
        const operational = buildOperationalGuidance(toolNameSet);
        if (operational) {
            staticParts.push(operational);
            sources.push('code:operational');
        }
        if (!isProactive) {
            const notificationGuidance = buildNotificationFormatGuidance();
            if (notificationGuidance) {
                staticParts.push(notificationGuidance);
                sources.push('code:notification-format');
            }
        }
        if (hasMemoryTool) {
            staticParts.push(MEMORY_GUIDANCE);
            sources.push('code:memory-guidance');
        }
    }

    const overlay = modelFamilyOverlay(def.model);
    if (overlay.body) {
        staticParts.push(overlay.body);
        sources.push(`code:model-overlay/${overlay.family}`);
    }

    // Per-agent custom prompt path WINS over the type-based role-delta when set —
    // lets users drop in a new agent (e.g. "merchant") without authoring a file
    // under roles/worker/. Resolved relative to FLOPSY_HOME, like all workspace
    // paths. Proactive fires still get the proactive override below.
    const customPromptRaw =
        def.promptPath && !(role === 'main' && isProactive)
            ? loadCustomPromptFile(def.promptPath, def.name)
            : undefined;
    // Proactive fires use a dedicated, smaller role-delta (proactive.md) that matches
    // the stripped toolset — main.md still references delegate_task/ask_user/etc. that
    // are filtered out for proactive turns. Falls back to main.md if proactive.md absent.
    const roleDeltaType = role === 'main' && isProactive ? 'proactive' : def.type;
    const roleDeltaRaw =
        customPromptRaw ??
        loadRoleDelta(role, roleDeltaType) ??
        (role === 'main' && isProactive ? loadRoleDelta(role, def.type) : undefined) ??
        ROLE_DELTA[role]?.[roleDeltaType] ??
        ROLE_DELTA[role]?.[def.type];
    // Resolve ${main} / ${peer:<key>} placeholders against the live roster so
    // role-deltas survive an agent rename. Authors who used literal names
    // pre-placeholders still work — substituteAgentRefs is a no-op for them.
    const roleDelta = roleDeltaRaw
        ? substituteAgentRefs(roleDeltaRaw, [
            ...(mainAgentName ? [{ name: mainAgentName, role: 'main' }] : []),
            ...(teamRoster ?? []).map((m) => ({
                name: m.name,
                ...(m.domain ? { domain: m.domain } : {}),
                type: m.type,
            })),
            { name: def.name, role, ...(def.domain ? { domain: def.domain } : {}), type: def.type },
        ])
        : undefined;
    if (roleDelta) {
        staticParts.push(roleDelta.trim());
        sources.push(
            customPromptRaw
                ? `agent.promptPath:${def.promptPath}`
                : `role:${role}/${roleDeltaType}`,
        );
    }

    if (role === 'worker') {
        const workerOrch = buildWorkerOrchestrationGuidance(toolNameSet);
        if (workerOrch) {
            staticParts.push(workerOrch);
            sources.push('code:worker-orchestration');
        }
    }

    if (role === 'main' && !isProactive && tools && tools.length > 0) {
        const agentsPath = workspace.config('AGENTS.md');
        try {
            const raw = readFileSync(agentsPath, 'utf8');
            const filtered = filterAgentsMdByTools(raw, toolNameSet);
            if (filtered) {
                staticParts.push(`<agent_protocol>\n${filtered}\n</agent_protocol>`);
                const total = raw.split(/^## /m).length - 1;
                const kept = filtered.split(/^## /m).length - 1;
                sources.push(`agents-md:filtered(${kept}/${total})`);
            }
        } catch {}
    }

    if (teamRoster && teamRoster.length > 0) {
        const lines: string[] = ['## Your Team', ''];
        lines.push(
            'When you need a capability you lack, delegate to the teammate whose kit includes it via `delegate_task` (short focused work) or `spawn_background_task` (long-running).',
        );
        lines.push('');
        lines.push('| Teammate | When to use | Toolsets | MCP servers |');
        lines.push('|----------|-------------|----------|-------------|');
        for (const m of teamRoster) {
            const ts = m.toolsets.length > 0 ? m.toolsets.join(', ') : '—';
            const mcp = m.mcpServers.length > 0 ? m.mcpServers.join(', ') : '—';
            const trigger = (m.whenToUse ?? m.domain ?? m.type).trim();
            lines.push(
                `| \`${m.name}\` | ${trigger} | ${ts} | ${mcp} |`,
            );
        }
        lines.push('');
        lines.push(
            'This table is the single source of truth for who does what. `delegate_task` and `spawn_background_task` route here — match the task to a teammate\'s "When to use" before picking.',
        );
        staticParts.push(lines.join('\n'));
        sources.push('dynamic:team-roster');

        const workerSkills = loadSkillOwnership(
            workspace.skills(),
            teamRoster.map((m) => m.name),
        );
        const workersWithSkills = Object.keys(workerSkills).sort();
        if (workersWithSkills.length > 0) {
            const skillLines: string[] = ['## Worker-owned skills', ''];
            skillLines.push(
                'These skills are tagged to a specific worker via `agent-affinity` and are NOT in your own catalog. When a request matches a skill below, `delegate_task` to the owner.',
            );
            skillLines.push('');
            skillLines.push('| Skill | Owner | When to use |');
            skillLines.push('|---|---|---|');
            for (const worker of workersWithSkills) {
                for (const sk of workerSkills[worker]) {
                    const trigger = sk.whenToUse ?? '(see skill body)';
                    skillLines.push(
                        `| \`${sk.name}\` | \`${worker}\` | ${trigger.slice(0, 140)} |`,
                    );
                }
            }
            staticParts.push(skillLines.join('\n'));
            sources.push('dynamic:worker-owned-skills');
        }

        sources.push('dynamic:worker-outputs(per-turn)');
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
        const useImperial = US_IMPERIAL_TZ.has(tz);
        const unitsLine = useImperial
            ? 'units: imperial (°F, mph, mi, lb)'
            : 'units: metric (°C, km/h, m, kg). NEVER use °F, mph, or other imperial units unless the user explicitly asks.';
        const family = modelFamily(def.model);
        const modelLine = def.model ? `model: ${def.model}  (family: ${family})` : 'model: (unset)';
        const peerLabel = cfg.peer?.name
            ? `${cfg.peer.name} <${cfg.peer.id}>`
            : (cfg.peer?.id ?? 'unknown');
        const channelName = cfg.channelName ?? 'unknown';
        const channelLine =
            channelName === 'unknown'
                ? 'channel: unknown'
                : `channel: ${channelName}  (${channelCapabilityHint(channelName)})`;
        const lines = [
            '<runtime>',
            `date: ${now.toISOString().slice(0, 10)}`,
            `time: ${now.toISOString()}`,
            `timezone: ${tz}`,
            unitsLine,
            `host: ${hostInfo()}`,
            modelLine,
            channelLine,
            `peer: ${peerLabel} (${cfg.peer?.type ?? 'unknown'})`,
        ];
        if (cfg.sender && cfg.sender.id !== cfg.peer?.id) {
            lines.push(`sender: ${cfg.sender.id}${cfg.sender.name ? ` (${cfg.sender.name})` : ''}`);
        }
        if (cfg.messageId) lines.push(`message-id: ${cfg.messageId}`);
        lines.push(`thread: ${ctx.threadId ?? 'unknown'}`);
        if (cfg.runtimeHints && cfg.runtimeHints.length > 0) {
            lines.push('runtime-hints:');
            for (const hint of cfg.runtimeHints) {
                lines.push(`  - ${hint}`);
            }
        }
        lines.push('workspace: /workspace  (read with /workspace/<path>)');
        lines.push('skills:    /skills     (read with /skills/<name>/SKILL.md)');
        lines.push('memory:    use the `memory` tool (action: add|replace|remove, target: user|memory)');
        lines.push('</runtime>');

        if (channelName !== 'unknown') {
            const guidance = channelGuidance(channelName);
            lines.push('');
            lines.push('<delivery_target>');
            lines.push(`channel: ${channelName}`);
            lines.push('');
            lines.push(guidance);
            lines.push('');
            lines.push(
                'Shape your reply for this channel — a reply that renders as a wall of text on a phone is a reply that did not arrive. Use the RESPONSE STYLE above as the default; deviate only when the user explicitly asks for a different shape (e.g. "give me a long write-up").',
            );

            // Auto-load the channel-specific skill if one exists. Skills live at
            // .flopsy/content/skills/channels/<channelName>/SKILL.md and carry the
            // hard rules (escape characters, banned syntax, native markdown
            // dialect). Without auto-injection the model would only see them via
            // an explicit skill_manage(read) call — which it usually skips, so
            // banned syntax (double asterisks, # headers, > blockquotes,
            // markdown tables) leaks into channels that can't render them.
            const skillPath = join(workspace.skills(), 'channels', channelName.toLowerCase(), 'SKILL.md');
            try {
                if (existsSync(skillPath)) {
                    const skillBody = readFileSync(skillPath, 'utf-8')
                        .replace(/^---[\s\S]*?^---\s*/m, '')
                        .trim();
                    if (skillBody.length > 0) {
                        lines.push('');
                        lines.push(`<channel_rules src="skills/channels/${channelName.toLowerCase()}/SKILL.md">`);
                        lines.push(skillBody);
                        lines.push('</channel_rules>');
                    }
                }
            } catch (err) {
                log.debug(
                    { err, channel: channelName, skillPath },
                    'failed to load channel skill (continuing)',
                );
            }

            lines.push('</delivery_target>');
        }

        if (role === 'main') {
            const { rows: woRows, total: woTotal } = loadWorkerOutputs(
                workspace.work('worker-outputs'),
            );
            if (woRows.length > 0) {
                lines.push('');
                lines.push('## Prior work (worker-outputs/)');
                lines.push('');
                lines.push(
                    'Full results that workers offloaded to disk in past turns. **Before fresh research / `web_search` / `delegate_task`, scan this list.** When a topic matches, read the file first — it may already answer the request.',
                );
                lines.push('');
                lines.push('| File | Worker | Topic | When | Size |');
                lines.push('|---|---|---|---|---|');
                for (const row of woRows) {
                    const topicCell = row.topic.length > 60 ? row.topic.slice(0, 57) + '…' : row.topic;
                    lines.push(
                        `| \`${row.file}\` | \`${row.worker}\` | ${topicCell} | ${formatRelativeTime(row.mtimeMs)} | ${formatSizeKB(row.sizeBytes)} |`,
                    );
                }
                if (woTotal > woRows.length) {
                    lines.push('');
                    lines.push(
                        `*(+${woTotal - woRows.length} older files — \`ls /workspace/work/worker-outputs/\` to see all)*`,
                    );
                }
                lines.push('');
                lines.push(
                    'Load any file with `read_file("/workspace/work/worker-outputs/<file>")`. Freshness rubric: <24h treat as current · 24h–7d verify with one targeted call · >7d use as background, re-run.',
                );
            }

            const planBody = loadPlanForThread(ctx.threadId);
            if (planBody && planBody.trim().length > 0) {
                lines.push('');
                lines.push('<plan description="Your persistent plan for this thread. Status markers: [todo] [doing] [done] [blocked]. Update via the `plan` tool — set replaces the whole plan; update_step changes one line. Don\'t re-derive what\'s already here.">');
                lines.push(planBody.trim());
                lines.push('</plan>');
            }
        }

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

        const stableTail = [staticPrompt, overlayBlock, briefBlock].filter(Boolean).join('\n\n');
        const volatileTail = lines.join('\n');
        return [stableTail, SYSTEM_PROMPT_CACHE_BOUNDARY, volatileTail]
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
    const sources =
        (buildSystemPrompt as unknown as { _lastSources?: string[] })._lastSources ?? [];
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
    const {
        enabled: _e,
        programmaticToolCalling: ptc,
        ...rest
    } = sb as {
        enabled?: boolean;
        programmaticToolCalling?: boolean;
        [k: string]: unknown;
    };
    void _e;

    const fgConfig = rest as FlopsygraphSandboxConfig;

    // Default the bridge transport to file-RPC over the workspace mount /
    // exec channel. Eliminates the docker proxy-sidecar / host.docker.internal
    // chain entirely (which is fragile and breaks bash when called before
    // execute_code, since startProxySidecar requires a bridgePort that only
    // the HTTP bridge sets). Explicit `bridgeTransport: 'http'` in flopsy.json5
    // still opts back into the legacy path.
    if (fgConfig.bridgeTransport === undefined) {
        fgConfig.bridgeTransport = 'file';
    }

    // Default workDir to FLOPSY_HOME/work so execute_code keeps its
    // ephemeral artifacts (`_run.sh` / `_run.py`, uv cache, pip downloads)
    // confined to .flopsy/work/ instead of leaking into the .flopsy/ root.
    // workspace.work() ensures the directory exists.
    if (!fgConfig.workDir) {
        fgConfig.workDir = workspace.work();
    }

    const skillsMount = { virtualPath: '/skills', hostPath: workspace.skills(), readOnly: true };
    if (!fgConfig.mounts?.some((m) => m.virtualPath === '/skills')) {
        fgConfig.mounts = [...(fgConfig.mounts ?? []), skillsMount];
    }

    if (!fgConfig.user && fgConfig.backend === 'docker') {
        const uid = process.getuid?.();
        const gid = process.getgid?.();
        if (uid != null && gid != null) fgConfig.user = `${uid}:${gid}`;
    }

    if (!fgConfig.restrictedPaths?.length) {
        fgConfig.restrictedPaths = ['auth/**', 'state/**', '*.key', '*.pem', '.env*'];
    }

    // Only the legacy HTTP transport needs host networking (proxy sidecar +
    // host.docker.internal). File-RPC transport runs over the workspace mount /
    // exec channel and doesn't need any inbound networking.
    const isolatedBackend = fgConfig.backend === 'docker' || fgConfig.backend === 'kubernetes';
    if (ptc && isolatedBackend && fgConfig.bridgeTransport === 'http' && fgConfig.networkEnabled !== true) {
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
