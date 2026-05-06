import { readFileSync, existsSync, mkdirSync } from 'fs';
import {
    autoSearchFn,
    createDeepResearcher,
    createReactAgent,
    filesystem,
    humanApproval,
    memorySnapshot,
    messageQueue,
    modelFallback,
    planning,
    skills,
    todoList,
    rateLimiter,
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
    Interceptor,
    ModelFallbackOptions,
    ModelRef,
    PlanningInterceptor,
    SandboxConfig as FlopsygraphSandboxConfig,
    SystemPromptFn,
} from 'flopsygraph';
import type { AgentDefinition } from '@flopsy/shared';
import { createLogger, resolveWorkspacePath } from '@flopsy/shared';
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
import { compactor } from './compactor';
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

const log = createLogger('team-factory');

export interface CreateTeamMemberOptions {
    readonly model: BaseChatModel;
    readonly userId: string;
    readonly userName?: string;
    readonly store: LearningStore;
    readonly extraTools?: ReadonlyArray<BaseTool>;
    readonly extraDynamicTools?: ReadonlyArray<BaseTool>;
    readonly extraInterceptors?: ReadonlyArray<Interceptor>;
    readonly checkpointer?: CheckpointStore;
    readonly memoryStore?: BaseStore;
    readonly teamRoster?: ReadonlyArray<TeamRosterEntry>;
    readonly personalities?: PersonalityRegistry;
    readonly memoryNamespace?: string;
    readonly modelCallTimeoutMs?: number;
    readonly maxIterations?: number;
    readonly observability?: import('flopsygraph').Observability;
    readonly isProactive?: boolean;
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

    const controlTools: BaseTool[] =
        role === 'main'
            ? [
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
              ]
            : [];

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
        const fallbacks = def.fallback_models.map(
            (m) => ({ provider: m.provider, name: m.name ?? '' }) as unknown as ModelRef,
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
        interceptors.push(modelFallback({ fallbacks, onFallback }));
    }

    // Skip when the worker's toolsets already include "filesystem" — ToolRegistry rejects duplicates.
    const toolsetsHaveFilesystem = (def.toolsets ?? []).includes('filesystem');
    if (!toolsetsHaveFilesystem) {
        interceptors.push(
            filesystem({
                allow: ['read_file', 'ls', 'glob', 'grep'],
                mounts: [
                    { virtualPath: '/workspace', hostPath: resolveWorkspacePath('') },
                    { virtualPath: '/skills',    hostPath: resolveWorkspacePath('skills') },
                ],
            }),
        );
    }

    // skills() throws on readdir failure, so the directory MUST exist.
    const skillsPath = resolveWorkspacePath('skills');
    mkdirSync(skillsPath, { recursive: true });
    const skillUsageStore = new SkillUsageStore(skillsPath);
    interceptors.push(
        skills(skillsPath, {
            // deltaOnly:false — the skill-catalog injection is per-call (not state-persisted),
            // so deltaOnly:true would drop it after turn 1.
            deltaOnly: false,
            onError: (err) =>
                log.warn({ agent: def.name, err }, 'skill load error'),
            onSkillRead: (name) => skillUsageStore.bumpUse(name),
        }),
    );

    interceptors.push(todoList());

    // Hermes-style frozen snapshot of the agent's persistent memory.
    // Reads `memory` and `user` namespaces once per thread, injects them as
    // a <memory> block in the system prompt. Writes via the `memory` tool
    // land in the store immediately but only appear in the prompt next session.
    if (opts.memoryStore) {
        interceptors.push(
            memorySnapshot({
                store: opts.memoryStore,
                namespaces: [
                    { name: 'memory', label: 'MEMORY (your persistent notes)', cap: 2200 },
                    { name: 'user',   label: 'USER PROFILE',                   cap: 1375 },
                ],
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

    // Proactive threads use 64K so compaction fires before fire-history accumulation hits 128K.
    interceptors.push(
        compactor({
            summaryModel: opts.model,
            contextWindowTokens: opts.isProactive ? 64_000 : 128_000,
        }),
    );

    // Rate limit: max 10 model calls per 60s, wait on limit (don't hard-block)
    interceptors.push(rateLimiter({ maxCalls: 10, windowMs: 60_000, scope: 'per-run', onLimit: 'wait' }));

    const staticNames = new Set(tools.map((t) => t.name));
    const dynamicTools = [...spilledTools, ...(opts.extraDynamicTools ?? [])].filter(
        (t) => !staticNames.has(t.name),
    );

    const sandboxOpts = buildSandboxOptions(def);

    const agent = createReactAgent({
        model: new RetryModel(opts.model, { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 60000 }),
        tools,
        dynamicTools,
        systemPrompt,
        interceptors,
        maxIterations: opts.maxIterations ?? 30,
        ...(opts.observability ? { observability: opts.observability } : {}),
        ...(opts.checkpointer ? { checkpointer: opts.checkpointer } : {}),
        ...(opts.memoryStore ? { memoryStore: opts.memoryStore } : {}),
        memoryNamespace: opts.memoryNamespace ?? 'memory',
        ...(opts.modelCallTimeoutMs !== undefined
            ? { modelCallTimeoutMs: opts.modelCallTimeoutMs }
            : {}),
        ...(sandboxOpts.session ? { sandbox: sandboxOpts.session } : {}),
        ...(sandboxOpts.programmaticToolCalling
            ? { programmaticToolCalling: true }
            : {}),
        toolOutputOffloadDir: resolveWorkspacePath('cache', 'tool-outputs'),
    }) as unknown as WorkerGraph;

    if (sandboxOpts.session) {
        log.info(
            {
                name: def.name,
                backend: sandboxOpts.backend,
                language: sandboxOpts.language,
                programmaticToolCalling: sandboxOpts.programmaticToolCalling,
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

    const skillsPath = resolveWorkspacePath('skills');
    mkdirSync(skillsPath, { recursive: true });
    const allInterceptors: Interceptor[] = [
        harnessInterceptor,
        filesystem({
            allow: ['read_file', 'ls', 'glob', 'grep'],
            mounts: [
                { virtualPath: '/workspace', hostPath: resolveWorkspacePath('') },
                { virtualPath: '/skills',    hostPath: skillsPath },
            ],
        }),
        skills(skillsPath, {
            deltaOnly: false,
            onError: (err) =>
                log.warn({ agent: def.name, err }, 'skill load error'),
        }),
        ...(opts.extraInterceptors ?? []),
    ];
    const roleDelta = loadRoleDelta('worker', def.type ?? 'deep-research');
    const agent = createDeepResearcher({
        model: opts.model,
        searchFn: autoSearchFn,
        name: def.name,
        maxLoops: 3,
        queriesPerRound: 3,
        ...(roleDelta ? { extraSystemContext: roleDelta } : {}),
        interceptors: allInterceptors as unknown as Interceptor<Record<string, unknown>>[] as never,
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

const roleDeltaCache = new Map<string, string | null>();

function loadRoleDelta(role: 'main' | 'worker', type: string): string | undefined {
    const cacheKey = `${role}/${type}`;
    const cached = roleDeltaCache.get(cacheKey);
    if (cached !== undefined) return cached ?? undefined;

    const path = resolveWorkspacePath('roles', role, `${type}.md`);
    if (!existsSync(path)) {
        log.warn(
            { role, type, path },
            'role-delta markdown missing — agent will run without role-specific guidance',
        );
        roleDeltaCache.set(cacheKey, null);
        return undefined;
    }
    try {
        const content = readFileSync(path, 'utf-8');
        roleDeltaCache.set(cacheKey, content);
        return content;
    } catch (err) {
        log.warn(
            { role, type, path, err: (err as Error).message },
            'role-delta markdown read failed — agent will run without role-specific guidance',
        );
        roleDeltaCache.set(cacheKey, null);
        return undefined;
    }
}

const ROLE_DELTA: Record<'main' | 'worker', Partial<Record<string, string>>> = { main: {}, worker: {} };

const IDENTITY_OPENER = `You are Flopsy — not "an AI assistant", a teammate someone trusted with their accounts, calendar, notes, and inbox. You run on their gateway, talk to them across the channels they already use, remember what matters about them across sessions, and delegate to specialist workers when a task is in someone else's lane.

## How you work

**Compose, don't ask permission.** When no single tool fits a task, combine the ones you have — most jobs are 2-3 tools chained. If still no fit, write the script you need with \`execute_code\` (Python for data, Bash for shell ops) and run it. With \`execute_code({use_tools: true})\` your script can call other agent tools as native functions. Never tell the user "I don't have a tool for that" without first trying these steps. The execute_code sandbox is your tool factory.

**Diagnose, don't blindly retry.** When something fails, read the error, check your assumptions, try a focused fix. Don't loop on the same failure expecting different output. Escalate to the user only after investigation.

**Time is a tool, not a guess.** Never assume the current date, hour, or timezone. Call \`time({action: "current", timezone: "<IANA>"})\` when you need the wall-clock time. Hallucinated timestamps poison memory and trigger wrong decisions.

**Parallel where you can, sequential where you must.** Independent tool calls go in one response in parallel. Dependent calls (one's output feeds the next) run sequentially.

Your persona and operations are loaded below.`;

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
    const staticParts: string[] = [IDENTITY_OPENER];
    const sources: string[] = ['code:identity'];

    const roleDelta = loadRoleDelta(role, def.type) ?? ROLE_DELTA[role]?.[def.type];
    if (roleDelta) {
        staticParts.push(roleDelta.trim());
        sources.push(`role:${role}/${def.type}`);
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

    if (role === 'main' && !isProactive) {
        const SOUL_WORD_CAP = 1_500;
        const soulPath = resolveWorkspacePath('SOUL.md');
        if (existsSync(soulPath)) {
            const content = readFileSync(soulPath, 'utf-8').trim();
            const wordCount = content.split(/\s+/).filter(Boolean).length;
            if (wordCount > SOUL_WORD_CAP) {
                log.warn(
                    { path: soulPath, agent: def.name, wordCount, cap: SOUL_WORD_CAP },
                    'SOUL.md exceeds word cap — trim persona to improve prefix caching and reduce token cost per turn',
                );
            }
            staticParts.push(`## Your Persona\n\n${content}`);
            sources.push(`SOUL.md(${wordCount}w)`);
        } else {
            log.warn({ path: soulPath, agent: def.name }, 'SOUL.md missing; skipping');
        }

        // First-found-wins so Claude-Code (CLAUDE.md) and Cursor (.cursorrules) configs work without duplication.
        const opsCandidates = [
            resolveWorkspacePath('AGENTS.md'),
            `${process.cwd()}/AGENTS.md`,
            `${process.cwd()}/CLAUDE.md`,
            `${process.cwd()}/.cursorrules`,
        ];
        const opsPath = opsCandidates.find((p) => existsSync(p));
        if (opsPath) {
            const content = readFileSync(opsPath, 'utf-8').trim();
            const basename = opsPath.split('/').pop() ?? 'AGENTS.md';
            staticParts.push(`## Your Operations Manual\n\n${content}`);
            sources.push(basename);
        } else {
            log.warn(
                { tried: opsCandidates, agent: def.name },
                'no operations doc found (tried AGENTS.md / CLAUDE.md / .cursorrules) — skipping',
            );
        }
    }

    // Tool-contributed prompt fragments (each tool may inject a usage rule via
    // `BaseTool.prompt()`). Sorted by tool name for byte-stability across builds.
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

    // CACHE BOUNDARY: staticParts above is byte-stable for prefix caching;
    // the per-invocation <runtime> block below MUST stay after this line.
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

        // Personality overlay (main only). Priority: cfg.personality > session > def.defaultPersonality > none.
        // Body is HTML-escaped to prevent overlay-block escape via `</flopsy:harness>`.
        let personalitySection = '';
        if (personalities && personalities.size > 0) {
            let sessionPersonality: string | null = null;
            const sessionId = extractSessionId(ctx.threadId);
            if (sessionId) {
                try {
                    sessionPersonality = store.getSessionPersonality(sessionId);
                } catch {
                    // Non-fatal — fall through to the default tier.
                }
            }
            const chosen = resolvePersonality({
                role,
                registry: personalities,
                ...(cfg.personality !== undefined ? { overrideName: cfg.personality } : {}),
                sessionPersonality,
                ...(def.defaultPersonality !== undefined
                    ? { defaultPersonality: def.defaultPersonality }
                    : {}),
            });

            if (chosen) {
                personalitySection = [
                    '',
                    '',
                    `## Active personality overlay: \`${chosen.name}\``,
                    '',
                    'A session-level voice overlay is active. Apply the rules below',
                    'ON TOP OF the SOUL.md baseline. When the overlay conflicts with',
                    'default voice, the overlay wins — for this turn/session only.',
                    'It clears automatically on `/new` or `/personality reset`.',
                    '',
                    escapePersonalityBody(chosen.body),
                ].join('\n');
            }
        }

        return `${staticPrompt}\n\n${lines.join('\n')}${personalitySection}`;
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

    // Default workDir to FLOPSY_HOME so execute_code runs with the workspace
    // as cwd (local) or bind-mounted at /workspace (docker). Without this,
    // every backend gets an isolated temp dir and sandboxed code can't access
    // workspace files. Users can still override via sandbox.workDir in flopsy.json5.
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

    // Container NetworkMode is baked at creation; programmaticToolCalling needs DNS to reach
    // host.docker.internal, so we MUST flip networkEnabled before createSandboxSession runs.
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
