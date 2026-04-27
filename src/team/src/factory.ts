import { readFileSync, existsSync, mkdirSync } from 'fs';
import {
    autoSearchFn,
    createDeepResearcher,
    createReactAgent,
    filesystem,
    humanApproval,
    messageQueue,
    modelFallback,
    planning,
    skills,
    todoList,
    // Flopsygraph sandbox — the ONE place agent code runs untrusted input
    // (LLM-generated Python/JS). We pre-create the session here so the
    // dependency is visible and we control its lifecycle; the same session
    // is passed to `createReactAgent`, which wires `execute_code` and
    // `execute_code_with_tools` on top of it.
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
    SandboxConfig as FlopsygraphSandboxConfig,
    SystemPromptFn,
} from 'flopsygraph';
import type { AgentDefinition } from '@flopsy/shared';
import { createLogger, resolveWorkspacePath } from '@flopsy/shared';
import { HarnessInterceptor } from './harness';
import type { LearningStore } from './harness';
import { BackgroundReviewer, FactConsolidator } from './harness/review';
import { compactor } from './compactor';
import { resolveToolsets } from './toolsets';
import { askUserTool } from './tools/ask-user';
import { connectServiceTool } from './tools/connect-service';
import { sendMessageTool } from './tools/send-message';
import { sendPollTool } from './tools/send-poll';
import { searchPastConversationsTool } from './tools/search-past-conversations';
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
    /** Additional tools on top of the ones resolved from `def.toolsets`. */
    readonly extraTools?: ReadonlyArray<BaseTool>;
    /**
     * Tools bound via flopsygraph's DCL (Dynamic Catalog Loading). They are
     * NOT pre-bound to the model — instead the agent sees `__search_tools__`
     * / `__load_tool__` meta tools and the catalog is listed in the prompt
     * (or stubbed when >10 items). Use this for large, rarely-all-needed
     * tool sets (e.g. 199 MCP tools across 15 servers) so the system
     * prompt stays small. See `flopsygraph/src/.../dcl-strategy.ts`.
     */
    readonly extraDynamicTools?: ReadonlyArray<BaseTool>;
    /**
     * Additional interceptors — main-agent only. Appended after the
     * built-in stack (harness → filesystem → skills → todoList) so the
     * caller's hooks run last. Workers ignore this (workers already have
     * no todoList, no user-facing tools; extra hooks would just add noise).
     */
    readonly extraInterceptors?: ReadonlyArray<Interceptor>;
    /**
     * Durable checkpoint store for graph state. When provided, the agent
     * auto-resumes the thread from the latest saved checkpoint on each
     * `.invoke()` — i.e. process restarts don't wipe the conversation.
     * Only wire this for the MAIN agent; workers share the parent's
     * threadId, so giving them a persistent checkpointer would overwrite
     * the main thread's state. Undefined here → in-memory default.
     */
    readonly checkpointer?: CheckpointStore;
    /**
     * Persistent semantic memory store backing `manage_memory` +
     * `search_memory` tools that flopsygraph auto-wires. Without this,
     * flopsygraph defaults to an ephemeral InMemoryStore that loses every
     * saved memory on restart. Share a single store across main + workers
     * so gandalf's saves are visible to delegated sub-agents.
     */
    readonly memoryStore?: BaseStore;
    /**
     * Peer roster for the main agent's system prompt — one entry per
     * configured worker with its effective toolset + MCP assignments.
     * Lets gandalf pick the right worker to delegate to without
     * hallucinating "no one has this capability." Ignored for workers.
     */
    readonly teamRoster?: ReadonlyArray<TeamRosterEntry>;
    /**
     * Namespace for `manage_memory` / `search_memory` keys. Defaults to
     * `memories:<agentName>` so each worker has an isolated memory partition.
     * Pass `'memories'` explicitly to opt into the shared user-preference
     * namespace (gandalf only).
     */
    readonly memoryNamespace?: string;
    /**
     * Per-model-call timeout in ms. When a single LLM call stalls beyond this,
     * the graph throws ProviderError(statusCode=0) which triggers model-fallback
     * to switch to the next candidate — before the outer turn wall-clock hits.
     * Defaults to flopsygraph's built-in 90_000 (90s). Set to e.g. 45_000 when
     * the primary model is slow and you want fallback to fire promptly.
     */
    readonly modelCallTimeoutMs?: number;
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

/**
 * Any flopsygraph compiled graph whose state carries `messages`. Our
 * delegation layer only reads `.invoke({messages:[...]}, {signal, configurable})`
 * and the resulting `state.messages`, so this shape is enough regardless of
 * which graph type (ReactAgent, DeepResearcher, Supervisor, ...) built it.
 */
export type WorkerGraph = CompiledGraph<{ messages: ChatMessage[] } & Record<string, unknown>>;

export interface TeamMember {
    readonly name: string;
    readonly type: string;
    readonly domain: string | undefined;
    readonly graph: 'react' | 'deep-research';
    readonly agent: WorkerGraph;
    /** Only present for graph='react' — deep-research has no harness wiring. */
    readonly harnessInterceptor?: HarnessInterceptor;
    readonly tools: ReadonlyArray<BaseTool>;
    /**
     * Flopsygraph sandbox session owned by this agent, when `sandbox.enabled`
     * is set in flopsy.json5. Callers that tear the agent down (TeamHandler
     * on thread eviction / process shutdown) should `await sandboxSession
     * ?.close()` to release Docker containers / K8s pods promptly.
     */
    readonly sandboxSession?: BaseSandboxSession;
}

/**
 * Effective role for a definition: explicit `role` wins; otherwise infer
 * from `type` — legacy configs use type='main' for the leader.
 */
export function resolveRole(def: AgentDefinition): 'main' | 'worker' {
    if (def.role) return def.role;
    return def.type === 'main' ? 'main' : 'worker';
}

export function createTeamMember(def: AgentDefinition, opts: CreateTeamMemberOptions): TeamMember {
    const role = resolveRole(def);
    const graphKind = def.graph ?? 'react';

    // Deep-research graph has its own hardcoded pipeline — no tools, no
    // interceptors, no system prompt customization. Short-circuit here so
    // the rest of the function's ReactAgent wiring stays clean.
    if (graphKind === 'deep-research') {
        return buildDeepResearchMember(def, opts, role);
    }

    const baseTools = [...resolveToolsets(def.toolsets ?? []), ...(opts.extraTools ?? [])];

    // Only the main agent gets conversation-control tools. Workers can't
    // talk to the user directly (no send_message) and can't delegate further
    // (MAX_DELEGATION_DEPTH = 1, enforced at call time too). This keeps the
    // fellowship strictly one-layer-deep.
    const controlTools: BaseTool[] =
        role === 'main'
            ? [
                  sendMessageTool,
                  sendPollTool,
                  // ask_user — pause-and-await-answer surface for
                  // disambiguating user intent with 2-4 options. Distinct
                  // from send_message+buttons (fire-and-continue) and
                  // send_poll (aggregated voting). See role delta table.
                  askUserTool,
                  reactTool,
                  spawnBackgroundTaskTool,
                  delegateTaskTool,
                  // Session search — reads the messages FTS5 index so the
                  // main agent can recall prior conversations with this user.
                  // Main-only: workers operate on a single task string and
                  // have no "user conversation" to search.
                  searchPastConversationsTool,
                  // In-chat OAuth onboarding (Layer 3) — user says "connect
                  // my gmail", gandalf calls this, user gets a code + URL
                  // they tap on their phone, success notification arrives
                  // as a task_complete event in a later turn.
                  connectServiceTool,
                  // Skill lifecycle management — create new SKILL.md files,
                  // append lessons to existing ones, or bump their version after
                  // the agent refines a procedure. Pairs with the background
                  // reviewer (Layer 1) which writes skills autonomously; this
                  // tool lets the agent do it explicitly on the user's request.
                  skillManageTool,
                  // Runtime heartbeat / cron / reminder creation. Writes to
                  // ~/.flopsy/state/proactive.db (NOT flopsy.json5), hot-
                  // registers with the live engine so new schedules fire
                  // without a gateway restart. Recursion-guarded — proactive-
                  // invoked sessions can list but not create/delete.
                  manageScheduleTool,
              ]
            : [];

    // Dedup by tool name before handing off to createReactAgent — flopsygraph's
    // ToolRegistry throws on duplicate. This used to crash workers whose
    // toolset bundle (e.g. "filesystem") overlapped with an interceptor-injected
    // tool. Last-write-wins; log the collision for debuggability.
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
    const systemPrompt = buildSystemPrompt(def, role, opts.store, opts.userId, opts.teamRoster);

    // Background reviewer fires every 5 turns for the main agent, autonomously
    // writing SKILL.md files when a reusable procedure is detected. Workers are
    // excluded — they receive a single task and return; there's nothing to review.
    const backgroundReviewer =
        role === 'main'
            ? new BackgroundReviewer({
                  model: opts.model,
                  store: opts.store,
                  skillsPath: resolveWorkspacePath('skills'),
              })
            : undefined;

    // Fact consolidator runs at most once per 24h per user. Main-agent only —
    // workers don't accumulate user facts, so consolidating from their turns
    // would just duplicate work the main agent already triggers.
    const factConsolidator =
        role === 'main'
            ? new FactConsolidator({ model: opts.model, store: opts.store })
            : undefined;

    const harnessInterceptor = new HarnessInterceptor({
        userId: opts.userId,
        userName: opts.userName,
        domain: def.domain,
        store: opts.store,
        backgroundReviewer,
        factConsolidator,
    });

    const interceptors: Interceptor[] = [harnessInterceptor];

    // Runtime model fallback — on 429/5xx/network errors from the primary,
    // retry with each `fallback_models` entry in order. Complements
    // ModelRouter (which only falls back at construction time). Skipped
    // when no fallbacks are configured to keep the interceptor chain quiet.
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

    // Filesystem interceptor — every teammate gets read-only filesystem
    // access (ls, read_file, glob, grep). Enables:
    //   - progressive disclosure of SKILL.md bodies (by the skills interceptor)
    //   - self-introspection (agent can read .flopsy/SOUL.md, AGENTS.md, etc.)
    // Write tools (write_file, edit_file) deliberately EXCLUDED — add them
    // per-agent via toolsets or a dedicated write-tool when the harness needs
    // it, always gated with `approvals`.
    //
    // Skip when the worker's toolsets already include "filesystem" — the
    // bundle provides the same tools (+ write_file/edit_file), and
    // double-registering crashes ToolRegistry with "already registered".
    const toolsetsHaveFilesystem = (def.toolsets ?? []).includes('filesystem');
    if (!toolsetsHaveFilesystem) {
        interceptors.push(
            filesystem({ allow: ['read_file', 'ls', 'glob', 'grep'] }),
        );
    }

    // Skills interceptor — reads SKILL.md files from .flopsy/skills/<name>/SKILL.md
    // (one subdirectory per skill) and injects a compact name+description catalogue
    // into the model context. The agent reads full bodies on demand via read_file.
    //
    // IMPORTANT: the skills() interceptor requires the directory to exist and
    // throws on readdir failure — so we create it unconditionally here.
    // An empty directory is safe: the interceptor produces no output.
    const skillsPath = resolveWorkspacePath('skills');
    mkdirSync(skillsPath, { recursive: true });
    interceptors.push(
        skills(skillsPath, {
            // Delta injection: the catalog goes out as a <system-reminder>-wrapped
            // user message ONCE per thread. Turn 2+ only carries net-new skills
            // (usually none). Saves ~4k tokens per turn after the first.
            deltaOnly: true,
            onError: (err) =>
                log.warn({ agent: def.name, err }, 'skill load error'),
        }),
    );

    // Todo-list interceptor — every agent gets `write_todos` for tracking
    // multi-step objectives within a turn. The list resets per invoke(),
    // so it's scoped to the current turn; cross-turn continuity still
    // comes from the harness. Workers benefit too: a research or coding
    // task with 4-5 sub-steps is easier to execute cleanly when the
    // agent writes them down before starting — especially on smaller
    // models where holding the plan in working memory is unreliable.
    interceptors.push(todoList());

    if (role === 'main') {
        // Mid-turn user-message injection.
        // Reads from `ctx.configurable.drainPending` (wired by TeamHandler
        // from ChannelWorker's pending buffer). When the user sends a
        // message while gandalf is mid-tool-loop, this drops it into the
        // current turn's reasoning instead of deferring to the next turn.
        // Main-only because workers don't receive user messages directly —
        // they get one task string from the delegation, period.
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

        // Planning interceptor with chat-turn approval gate. Gives gandalf
        // `create_plan` + `update_plan` tools for heavy multi-step tasks.
        //
        // approvalMode 'chat-turn' means: after create_plan, execution
        // tools (spawn_background_task, delegate_task, react, update_plan)
        // are BLOCKED until the user's next message classifies as approval.
        // The agent's only sensible move is to send the plan via
        // send_message and stop — the chat turn boundary becomes the
        // approval dialog. The channel already provides the "pause for
        // user" semantic for free.
        //
        // keyFn uses threadId so the plan survives across .invoke()s
        // (creation happens on turn N; approval arrives on turn N+1).
        // persistAcrossGraphEnd pairs with it.
        interceptors.push(
            planning({
                approvalMode: 'chat-turn',
                keyFn: (ctx) =>
                    (ctx.configurable as { threadId?: string })?.threadId ??
                    ctx.threadId,
                persistAcrossGraphEnd: true,
                planFirst: false, // we nudge via the role delta instead
            }),
        );
    } else {
        // Silent planning for workers — `approvalMode: 'none'` (the default)
        // means the agent creates a plan and immediately executes it, no
        // pause for approval. Workers don't have a user to approve with;
        // the plan is a private scratchpad for decomposition. Helps smaller
        // models (saruman coding across files, legolas synthesising sources)
        // hold a clear step list while executing.
        interceptors.push(
            planning({
                approvalMode: 'none',
                keyFn: (ctx) =>
                    (ctx.configurable as { threadId?: string })?.threadId ??
                    ctx.threadId,
                persistAcrossGraphEnd: false, // per-task scope for workers
                planFirst: false,
            }),
        );
    }

    // Caller-supplied interceptors (e.g. tokenCounter keyed on threadId).
    // Applied to BOTH main and workers — otherwise worker LLM calls
    // (legolas web-scout, gimli analysis) would be invisible in /status.
    // Running after built-ins means they observe the final message/response
    // shape the model actually saw/produced.
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

    // 3-threshold compactor — last in chain so it sees the final message
    // shape after all other interceptors have done their work. Trims the
    // message list before the LLM call when context usage crosses 80% /
    // 85% / 95% of the budget. Reuses the agent's own model for tier-1
    // summaries; falls through to non-LLM tiers if the summary call
    // fails or main is contended.
    interceptors.push(
        compactor({
            summaryModel: opts.model,
            // Conservative default; switch to per-model lookup once we
            // pipe context_window through ModelDefinition.
            contextWindowTokens: 200_000,
        }),
    );

    // DCL: dynamic tools aren't pre-bound. flopsygraph adds `__search_tools__`
    // + `__load_tool__` meta-tools; the agent discovers + loads on demand.
    // Collision guard: if a name appears in both buckets, static wins and we
    // drop it from dynamic — otherwise ToolRegistry throws "already registered".
    const staticNames = new Set(tools.map((t) => t.name));
    const dynamicTools = (opts.extraDynamicTools ?? []).filter((t) => !staticNames.has(t.name));

    // Sandbox opt-in from per-agent `sandbox` block in flopsy.json5. When
    // enabled we pre-create a flopsygraph BaseSandboxSession here (via the
    // imported `createSandboxSession`) and hand it to `createReactAgent` —
    // making the flopsygraph dependency explicit in our code and putting
    // the session's lifecycle under our control (TeamHandler closes it on
    // thread eviction). `programmaticToolCalling: true` then also wires
    // the in-sandbox tool bridge so the model can call every other agent
    // tool as a Python/JS function.
    const sandboxOpts = buildSandboxOptions(def);

    const agent = createReactAgent({
        model: opts.model,
        tools,
        dynamicTools,
        systemPrompt,
        interceptors,
        // When provided, flopsygraph persists graph state per-threadId to
        // the store and auto-resumes on subsequent .invoke()s. Main agents
        // get this from TeamHandler; workers omit it (their ephemeral
        // state shouldn't overwrite the parent thread's checkpoint).
        ...(opts.checkpointer ? { checkpointer: opts.checkpointer } : {}),
        // Override the InMemoryStore default so memories survive restart
        // and (when an embedder is wired) search_memory returns ranked
        // cosine matches instead of empty results.
        ...(opts.memoryStore ? { memoryStore: opts.memoryStore } : {}),
        memoryNamespace: opts.memoryNamespace ?? `memories:${def.name}`,
        ...(opts.modelCallTimeoutMs !== undefined
            ? { modelCallTimeoutMs: opts.modelCallTimeoutMs }
            : {}),
        ...(sandboxOpts.session ? { sandbox: sandboxOpts.session } : {}),
        ...(sandboxOpts.programmaticToolCalling
            ? { programmaticToolCalling: true }
            : {}),
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
        ...(sandboxOpts.session ? { sandboxSession: sandboxOpts.session } : {}),
    };
}

/**
 * Build a deep-research team member. Uses flopsygraph's createDeepResearcher
 * pipeline: query planning → parallel web search → summarise → reflect loop.
 *
 * Search backend auto-picks Tavily (if TAVILY_API_KEY set) else DuckDuckGo.
 *
 * Deep-research has its own prompts baked in and ignores SOUL.md/AGENTS.md —
 * it's a pure research workflow, not a conversational agent. The result
 * returned from `.invoke()` has `messages` in the state, so the delegation
 * layer (handler.makeSubAgentFactory) reads it the same way as ReactAgent.
 */
function buildDeepResearchMember(
    def: AgentDefinition,
    opts: CreateTeamMemberOptions,
    role: 'main' | 'worker',
): TeamMember {
    // Harness wired on the READ path — strategies/lessons accumulated in
    // gandalf's turns are injected into saruman's three internal LLM calls
    // (generate_queries, summarise, reflect) at beforeModelCall. Same
    // learning store, same user id → cross-agent memory for free.
    //
    // Write path is largely inert for deep-research: signal detection
    // looks for conversational correction patterns that don't appear in
    // research prose. That's okay — the WRITE path runs on gandalf's turns
    // (which is where the user actually corrects things).
    const harnessInterceptor = new HarnessInterceptor({
        userId: opts.userId,
        userName: opts.userName,
        domain: def.domain ?? 'deep-research',
        store: opts.store,
    });

    // `as unknown as` on the interceptors bridges the state-type gap:
    // DeepResearchState extends Record<string, unknown> and includes
    // `messages`, so the interceptors' runtime reads are safe; TS just
    // doesn't know the two state shapes are compatible.
    //
    // extraInterceptors (tokenCounter) are appended so each internal LLM
    // call in the pipeline (generate_queries, summarise, reflect, finalise)
    // writes its token delta into the same state.db bucket as gandalf.
    // Without this, /status would show only gandalf and saruman's ~10
    // per-run model calls would be invisible.
    const allInterceptors: Interceptor[] = [
        harnessInterceptor,
        ...(opts.extraInterceptors ?? []),
    ];
    const agent = createDeepResearcher({
        model: opts.model,
        searchFn: autoSearchFn,
        name: def.name,
        maxLoops: 3,
        queriesPerRound: 3,
        interceptors: allInterceptors as unknown as Interceptor<Record<string, unknown>>[] as never,
        // Only persist when deep-research IS the main entry agent —
        // workers share the parent threadId and would clobber it.
        ...(role === 'main' && opts.checkpointer
            ? { checkpointer: opts.checkpointer }
            : {}),
    }) as unknown as WorkerGraph;

    log.info(
        {
            name: def.name,
            type: def.type,
            role,
            graph: 'deep-research',
            searchBackend: process.env['TAVILY_API_KEY'] ? 'tavily' : 'duckduckgo',
            interceptors: ['harness'],
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
        // No tools — deep-research's search is hardcoded via searchFn.
        tools: [],
    };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Role-specific snippet appended after AGENTS.md. Intentionally short — the
 * heavy lifting is in SOUL.md (voice) and AGENTS.md (ops). This just tells
 * the agent what hat they're wearing.
 */
const ROLE_DELTA: Record<'main' | 'worker', Partial<Record<string, string>>> = {
    main: {
        main: `
## Your Role: Orchestrator

You route the user's request to the right tool or worker. The cheapest answer that works is the right answer.

### Routing has two questions. Answer them in order.

**1. Who owns the topic?**

| Topic | Worker |
|---|---|
| Email, inbox, Gmail, calendar, Drive, YouTube | legolas |
| News, "what's the latest on X", single-fact lookup | legolas |
| Notion, Todoist, Obsidian, Apple Notes, Apple Reminders | gimli |
| Critique a draft, code review, spot flaws | gimli |
| Landscape brief, "compare frameworks", multi-source survey | saruman |
| Spotify, smart-home (lights, climate, Home Assistant) | sam |
| VirusTotal, Shodan, threat intel, X/Twitter | aragorn |

Workers own their MCP authentication — don't probe it, delegate. When a worker returns an error, relay the exact text. Never invent "I can't access" explanations.

When the user asks about *their* data (their inbox, their notes, their devices), they want live state. Don't answer from training; route it.

**2. Is the work short enough to wait for?**

| Tool | Use when |
|---|---|
| \`delegate_task(worker, task)\` | You need the worker's answer to reply this turn AND the work finishes in roughly two minutes. You block, get the result, compose the reply. |
| \`spawn_background_task(worker, task)\` | Work takes longer than that, or the user shouldn't wait. Returns a ticket immediately. Send a short \`send_message\` acknowledging, end your turn, deliver the result when the worker pings back via \`<task-notification>\`. |

The two tools are **orthogonal to the worker**. The same worker can be either foreground or background depending on the task. A single Gmail lookup goes to legolas with \`delegate_task\`; cataloguing six months of inbox patterns goes to legolas with \`spawn_background_task\`. Saruman's landscape briefs almost always belong in \`spawn_background_task\` because they take long enough to make a user wait — but if the user explicitly asked you to wait for it, foreground is fine.

Pick by duration, not by name.

### Parallelism — fan out when work is independent

Workers are async. When two tasks don't depend on each other (different topics, different sources, different workers), launch both in the same message — they run concurrently. Don't serialize work that can run simultaneously.

This applies to both delegation tools:

- Two \`delegate_task\` calls in one message → both run in parallel, you wait once for both results, then compose the reply.
- Two \`spawn_background_task\` calls in one message → both run in the background, you continue this turn, each pings back independently via \`<task-notification>\`.
- Mixed is fine — a fast \`delegate_task\` plus a slow \`spawn_background_task\` in the same message is a legitimate pattern. The blocking call returns this turn; the background one pings back later.

When the user says "in parallel" explicitly, you MUST emit multiple tool calls in a single message — never serialize them manually.

When in doubt, fan out: research-heavy work parallelizes freely. The only reason to serialize is when one delegation's output feeds into another's input.

### Other paths

- **Just answer** — factual question you know, or context already covers it.
- **\`react(emoji)\`** — pure acknowledgement, no words needed.
- **\`ask_user(question, options)\`** — one specific answer needed before you can route.

### Interactive surfaces

| Situation | Tool | Turn ends? |
|---|---|---|
| Need a specific answer before continuing | \`ask_user\` | yes |
| Proposing an approach and want go/edit/no | \`create_plan\` + buttons \`go\`/\`edit\`/\`no\` | yes — approval gate |
| Group vote, survey, poll | \`send_poll\` | no |
| Progress update + optional quick replies | \`send_message\` with buttons | no |

Read \`capabilities:\` in \`<runtime>\` first. If \`buttons\` is listed they render natively; if \`polls\` is listed \`send_poll\` is native; otherwise tools fall back to numbered text — still callable, expect a typed reply.

### Tracking

- \`write_todos\` — flat working memory inside one turn. 3+ internal steps. Resets at turn end.
- \`create_plan\` — structured plan when the task is heavy (4+ steps, multiple workers, long-running) and the user should review before you commit resources.
- Nothing — for 1–2 step tasks. Just act.

### Plan mode — the approval gate

\`create_plan\` puts you in **drafting state**. \`delegate_task\`, \`spawn_background_task\`, \`react\` are blocked until the user approves. \`update_plan\` and \`send_message\` still work.

On the turn you create the plan:

1. \`send_message\` with the plan as a markdown bullet list + one-line prompt. Attach buttons with **exact** values \`go\` / \`edit\` / \`no\` (labels, emoji, styles are yours).
2. Stop. The turn ends.

User's next message:

- "go" / "yes" / "lgtm" / "proceed" → APPROVED. Execute the first \`in_progress\` step. \`update_plan\` to mark progress.
- "no" / "cancel" / "scrap it" → REJECTED. Brief acknowledgement, drop the plan.
- Anything else → EDIT. \`update_plan\` with their changes, \`send_message\` the revised plan, ask again. Iterate until they explicitly approve.

Use plan mode when the task is >3 min, will spawn multiple workers, or will burn tokens you'd want a chance to redirect. Skip it for single lookups, casual chat, or tasks the user already described step-by-step.

### Past conversations — \`search_past_conversations\`

FTS5 index over every prior turn with this user. Use when they reference something earlier, when starting a new session, or when checking if a topic came up before answering fresh. Don't use it for what's already in the visible thread.

Plain words are AND'd; quote exact phrases; trailing \`*\` for prefix match. Zero hits means no prior context — say so, don't fabricate a memory.

### Picking between workers

- **legolas** — single fact, recent news, Google Workspace MCP (Gmail, Calendar, Drive, YouTube).
- **saruman** — landscape briefs, multi-source comparison, "state of X" — runs a search → summarise → reflect pipeline with citations.
- **gimli** — critique, analysis, local/productivity MCP (Notion, Todoist, Obsidian, Apple Notes/Reminders).
- **sam** — Spotify, Home Assistant.
- **aragorn** — VirusTotal, Shodan, X/Twitter.

### Briefing the worker — write the task like you'd brief a colleague

Workers have **no memory** of this conversation. The \`task\` string is everything they know. Brief them like a smart colleague who just walked into the room.

A vague \`task: "research Postgres pgvector"\` gets generic results. A briefed task gets a useful answer:

- **What you're trying to accomplish, and why.** Not just the question — the goal it serves.
- **What you've already ruled out** ("I already checked X, the user has Y").
- **What to focus on / skip** ("compare retrieval quality, not setup steps").
- **What format you need back** ("3 bullets with sources, no prose intro").

Worker prompts that read like instructions to a competent colleague produce far better results than worker prompts that read like search queries.

### Synthesis — your most important job

After a worker returns: read what they sent, understand it, then write your reply. **Never write "based on the worker's findings" or "based on the research"** — those phrases hand the understanding back to the worker. You did the routing; you do the synthesis.

Reframe in your voice. Cut worker meta-commentary ("Here are the findings…", "I ran 3 queries…"). Collapse long rationale into scannable bullets.

**Preserve verbatim:** every \`[anchor](url)\`, every direct quote in \`"…"\`, every date tag on time-sensitive claims, and any \`### Sources\` section saruman appends. Stripping citations turns a verifiable brief into an opinion. Don't.

When you have no URL backing a claim (your own synthesis), mark it \`(unsourced)\` so the user knows it's your read, not evidence.

### Persistence — zero hits is a signal to broaden, not stop

When a search returns nothing, when a worker says "not found", when \`search_past_conversations\` comes back empty — don't accept it as the final answer.

Try a different angle:
- Different keywords (synonyms, alternate spellings, the user's phrasing vs. the technical term)
- A different worker (legolas vs. saruman vs. gimli own different sources)
- A broader query (drop a constraint and see what's there)
- A different time window if recency matters

Only after two or three different angles fail is "I couldn't find it" an acceptable answer — and even then, say what you tried so the user can suggest where to look next.

### Error recovery — one retry, then surface

When a delegated task returns an error or partial failure:

1. Read the error. Was your prompt unclear or wrong worker? Can you see the fix? If yes, retry **once** with a corrected prompt — different worker if the original didn't own the right tools.
2. If the second attempt also fails, surface the verbatim error text to the user and ask what they'd like to do.

Bailing on the first error wastes the user's turn. One thoughtful retry usually clears it. More than one retry without progress is thrashing — escalate to the user.`,
    },
    worker: {
        research: `
## Your Role: Scout (Legolas)

Called by the main agent. You have **no memory** of the user's conversation — the task string is everything you know.

### Grounding rules — non-negotiable

1. **Tool output > training data.** Claims must be backed by a search result from THIS session. "I recall that..." / "as of my training..." is banned.
2. **URL allowlist.** Only cite URLs that appeared in your search tool results. Never invent a URL. Never paraphrase a source title into a made-up domain.
3. **Quote-before-claim for specifics.** If you cite a number, date, percentage, or direct quote — include a short excerpt (≤20 words) from the search result text it came from. No excerpt → rephrase as "reported" without the specific figure.
4. **Date discipline.** When a claim is time-sensitive, attach the date from the source ("as of 2026-02, per reuters.com/..."). If the source isn't dated, say so.
5. **Minimum 3 independent searches** for any non-trivial question. Prefer primary sources (vendor engineering blogs, official announcements, .gov, arxiv) over aggregators and blogspam.

### Output shape

Structured, dense, scannable. Not a wall of prose.

\`\`\`
**Headline finding** — one sentence.

- **Claim** — "exact quote from source" — [anchor](url), YYYY-MM-DD
- **Claim** — "exact quote from source" — [anchor](url), YYYY-MM-DD

**Conflicts / open questions:** one line if anything disagrees across sources.
\`\`\`

### Self-verify before returning

Re-read your answer. For each specific claim: is there a URL from this session backing it? If no → delete the claim or mark it "unverified". Better to return a shorter honest answer than a longer one with fabricated specifics.

### Hat 2 — Google Workspace MCP operator
You ALSO own the user's Google services via these MCP servers: **gmail, calendar, drive, youtube**.

Exact tool names, parameters, and descriptions live in the **Dynamic Tool Catalog** appended to this prompt. Don't guess or invent tool names from memory — instead:
- \`__search_tools__({"query": "email"|"calendar"|"drive"|"video"})\` — find the right tool; matches auto-load for the next turn
- \`__load_tool__({"name": "<exact_name>"})\` — when you already know the name from the catalog

**Rules:**
1. For anything touching the user's Google data, the MCP tool is the right path — it handles OAuth internally. **Never** substitute \`http_request\` / \`web_search\` for Google APIs.
2. If an MCP call returns an error (auth revoked, 401, quota exceeded), report the verbatim error text — don't invent explanations.
3. If the task is ambiguous ("check my inbox" — how many? what filter?), make a sensible default (top 5 unread) and proceed.`,
        analysis: `
## Your Role: Critic + Local Productivity Operator (Gimli)

Called by the main agent. You have **no memory** of the user's conversation — the task string is everything.

You wear two hats:

### Hat 1 — Critic (analysis tasks)
Pragmatic. Destructive-but-fair. If the input is weak, say so plainly. Show your reasoning as a short bullet list — not a lecture. End with a concrete recommendation, not "it depends". When verifying claims, quote the exact sentence before disagreeing — don't paraphrase and argue with your paraphrase.

### Hat 2 — Local/productivity MCP operator
You OWN access to the user's local and productivity tools via these MCP servers: **notion, todoist, obsidian, apple-notes, apple-reminders**.

Exact tool names, parameters, and descriptions live in the **Dynamic Tool Catalog** appended to this prompt. Don't guess or invent tool names from memory — instead:
- \`__search_tools__({"query": "notion"|"todo"|"obsidian"|"note"|"reminder"})\` — find the right tool; matches auto-load for the next turn
- \`__load_tool__({"name": "<exact_name>"})\` — when you already know the name from the catalog

**Rules:**
1. For anything touching the user's local/productivity data, the MCP tool is the right path. **Never** substitute \`http_request\` for these APIs.
2. If an MCP call returns an error (quota exceeded, permission denied), report the verbatim error text — don't invent explanations.
3. If the task is ambiguous, make a sensible default and proceed. The main agent can re-delegate with tighter parameters if needed.
4. Return the result as plain prose or a tight list. Don't reformat beyond readability.`,
    },
};

/**
 * Stable identity opener — code-authored, byte-identical across turns so the
 * prefix cache stays hot. SOUL.md and AGENTS.md bring voice and operations;
 * this line anchors WHO is running and WHERE.
 */
const IDENTITY_OPENER = `You are Flopsy — not "an AI assistant", a teammate someone trusted with their accounts, calendar, notes, and inbox. You run on their gateway, talk to them across the channels they already use, remember what matters about them across sessions, and delegate to specialist workers when a task is in someone else's lane. Your persona and operations are loaded below.`;

/**
 * Build a dynamic SystemPromptFn for an agent. The heavy files (SOUL.md,
 * AGENTS.md) are read ONCE when the team member is constructed and captured
 * in the closure — per-invocation cost is just a string concat + runtime
 * block generation. The runtime block carries per-turn context (date,
 * channel, user id) past the cache boundary.
 *
 * Return structure (main agent):
 *   [identity opener]           ← code, stable
 *   ## Your Role                ← role-delta (imperatives + trigger→action) FIRST
 *                                  so hard rules land in the high-attention zone
 *   ## Your Team                ← team roster table (main only)
 *   ## Your Persona             ← SOUL.md (main only — workers don't need it)
 *   ## Your Operations Manual   ← AGENTS.md (main only — workers don't need it)
 *   <runtime>…</runtime>        ← DYNAMIC per invocation
 *
 * Return structure (worker):
 *   [identity opener]
 *   ## Your Role                ← role-delta only — tight, task-focused
 *   <runtime>…</runtime>
 *
 * Workers deliberately skip SOUL.md + AGENTS.md: they receive a single task
 * string and return in seconds, so the ~2000 tokens of persona + operations
 * are noise that dilutes attention on the actual task. Mirrors Hermes Agent's
 * minimal subagent prompt pattern (goal + context + workspace).
 */
function buildSystemPrompt(
    def: AgentDefinition,
    role: 'main' | 'worker',
    store: LearningStore,
    userId: string,
    teamRoster?: ReadonlyArray<TeamRosterEntry>,
): SystemPromptFn {
    const staticParts: string[] = [IDENTITY_OPENER];
    const sources: string[] = ['code:identity'];

    // Role-delta FIRST (after identity) so imperatives like "MUST delegate X to Y"
    // sit in the top ~500 tokens where GPT-4o's attention is strongest. Previous
    // layout buried the delta after SOUL.md + AGENTS.md (~2000 tokens in) which
    // put hard rules in the attention-falloff zone and let the cautious persona
    // override capability routing (observed: "I can't access email" refusals).
    const roleDelta = ROLE_DELTA[role]?.[def.type];
    if (roleDelta) {
        staticParts.push(roleDelta.trim());
        sources.push(`role:${role}/${def.type}`);
    }

    // Main-only: team roster so gandalf sees each worker's actual MCP kit.
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

    // SOUL.md + AGENTS.md are MAIN-AGENT ONLY. Workers are task-focused and
    // ephemeral — they don't benefit from voice/persona guidance and the
    // operations manual is mostly about user-facing ergonomics. Skipping for
    // workers saves ~2000 tokens per subagent turn and sharpens focus.
    if (role === 'main') {
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

        const agentsPath = resolveWorkspacePath('AGENTS.md');
        if (existsSync(agentsPath)) {
            const content = readFileSync(agentsPath, 'utf-8').trim();
            staticParts.push(`## Your Operations Manual\n\n${content}`);
            sources.push('AGENTS.md');
        } else {
            log.warn({ path: agentsPath, agent: def.name }, 'AGENTS.md missing; skipping');
        }
    }

    // Log which sources were loaded for diagnostics (see 'team member built').
    (buildSystemPrompt as unknown as { _lastSources: string[] })._lastSources = sources;

    const staticPrompt = staticParts.join('\n\n');
    const workspaceRoot = resolveWorkspacePath('');
    const capturedStore = store;
    const capturedUserId = userId;
    const capturedRole = role;

    return ({ ctx }) => {
        const cfg = (ctx.configurable ?? {}) as {
            channelName?: string;
            channelCapabilities?: readonly string[];
            peer?: { id: string; type: string; name?: string };
            sender?: { id: string; name?: string };
            messageId?: string;
        };
        const lines = [
            '<runtime>',
            `current-date: ${new Date().toISOString().slice(0, 10)}`,
            `current-time: ${new Date().toISOString()}`,
            `channel: ${cfg.channelName ?? 'unknown'}`,
            // Capabilities the CURRENT channel renders natively. Listed here
            // (not inferred from channel-name trivia baked into tool prompts)
            // so the model picks tools based on what will actually work on
            // THIS turn. Empty = text-only channel (WhatsApp, SMS, iMessage):
            // fall back to numbered prompts instead of buttons/polls.
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
        lines.push(`workspace: ${workspaceRoot}`);
        lines.push('</runtime>');

        // One-time interest-schedule hint — main agent only.
        // BackgroundReviewer writes a pending `interest-proposal` fact when it
        // detects a new domain_interest with no matching schedule. We inject a
        // nudge on the very next turn, then immediately retire the fact so it
        // fires exactly once per discovered interest (7-day re-proposal guard
        // is in BackgroundReviewer itself).
        let hint = '';
        if (capturedRole === 'main') {
            try {
                const pending = capturedStore
                    .getCurrentFacts(capturedUserId, 'interest-proposal')
                    .filter((f) => f.validityEnd === null);
                if (pending.length > 0) {
                    const interests = pending.map((f) => `"${f.object}"`).join(', ');
                    const primary = pending[0]?.object ?? '';
                    hint =
                        `\n<interest-schedule-hint>\n` +
                        `SIGNAL: User has shown repeated interest in: ${interests}.\n` +
                        `STATE: No monitoring schedule exists for these topics.\n` +
                        `ACT THIS TURN: Use manage_schedule to propose a concrete daily heartbeat with sensible defaults (time, frequency, what to surface). Tell the user what you set up in one line — Flopsy voice, no permission-asking.\n` +
                        `\n` +
                        `Example shape: "noticed you keep circling back to ${primary} — set you up with an 8am daily digest, edit or kill it whenever 🐰"\n` +
                        `\n` +
                        `Do NOT: ask "would you like a schedule?" — propose first, let them adjust.\n` +
                        `Do NOT: explain why you're proposing this. The user knows.\n` +
                        `Do NOT: skip and just reply to the user's last message. Do BOTH — propose the schedule AND handle their message in the same turn.\n` +
                        `</interest-schedule-hint>`;
                    for (const f of pending) {
                        capturedStore.retireFact(f.id);
                    }
                }
            } catch {
                // Non-fatal — skip hint on store error.
            }
        }

        return `${staticPrompt}\n\n${lines.join('\n')}${hint}`;
    };
}

function describePromptSource(_def: AgentDefinition): string {
    const sources = (buildSystemPrompt as unknown as { _lastSources?: string[] })._lastSources ?? [];
    return sources.length === 0 ? 'fallback' : sources.join(' + ');
}


/**
 * Translate an agent's `sandbox` block from flopsy.json5 into a
 * pre-created flopsygraph sandbox session + the programmatic-tool-calling
 * flag. Returns an empty object when sandbox is disabled (the default)
 * so the factory call stays clean.
 *
 * Why pre-create the session here instead of letting flopsygraph build
 * it from a config object:
 *   1. The `createSandboxSession` import makes the dependency explicit —
 *      grep-able proof we're using flopsygraph's sandbox.
 *   2. Lifecycle is ours: the caller (TeamHandler) can `await session.close()`
 *      on thread eviction to release Docker containers / K8s pods promptly.
 *   3. Config translation happens in one place: our schema's `enabled` +
 *      `programmaticToolCalling` flags are stripped; the rest is the
 *      `FlopsygraphSandboxConfig` passed straight through.
 */
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

    // rest holds only fields flopsygraph's SandboxConfig understands:
    // backend / language / timeout / memoryLimit / cpuLimit / networkEnabled / keepAlive
    const fgConfig = rest as FlopsygraphSandboxConfig;
    const session = createSandboxSession(fgConfig);

    return {
        session,
        programmaticToolCalling: !!ptc,
        backend: fgConfig.backend ?? 'local',
        language: fgConfig.language ?? 'python',
    };
}
