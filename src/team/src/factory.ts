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
    SystemPromptFn,
} from 'flopsygraph';
import type { AgentDefinition } from '@flopsy/shared';
import { createLogger, resolveWorkspacePath } from '@flopsy/shared';
import { HarnessInterceptor } from './harness';
import type { LearningStore } from './harness';
import { BackgroundReviewer } from './harness/review';
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
    const systemPrompt = buildSystemPrompt(def, role, opts.teamRoster);

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

    const harnessInterceptor = new HarnessInterceptor({
        userId: opts.userId,
        userName: opts.userName,
        domain: def.domain,
        store: opts.store,
        backgroundReviewer,
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

    // DCL: dynamic tools aren't pre-bound. flopsygraph adds `__search_tools__`
    // + `__load_tool__` meta-tools; the agent discovers + loads on demand.
    // Collision guard: if a name appears in both buckets, static wins and we
    // drop it from dynamic — otherwise ToolRegistry throws "already registered".
    const staticNames = new Set(tools.map((t) => t.name));
    const dynamicTools = (opts.extraDynamicTools ?? []).filter((t) => !staticNames.has(t.name));

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
    }) as unknown as WorkerGraph;

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

You route user requests to the right tool or worker. Your first response on any turn should almost always be a tool call — not a message explaining what you can't do.

### Hard routing rules — check these BEFORE replying

| User mentions | You MUST call |
|---|---|
| email, inbox, Gmail, unread mail, "check mail" | \`delegate_task("legolas", "<specific task>")\` |
| calendar, schedule, "what's on today", event, meeting | \`delegate_task("legolas", "<specific task>")\` |
| Google Drive, "find file X", docs, shared folder | \`delegate_task("legolas", "<specific task>")\` |
| YouTube, video search, playlist, subscriptions | \`delegate_task("legolas", "<specific task>")\` |
| Notion, "search my workspace", Notion page | \`delegate_task("gimli", "<specific task>")\` |
| Todoist, "add task", todo list | \`delegate_task("gimli", "<specific task>")\` |
| Obsidian, "my notes", vault, Apple Notes | \`delegate_task("gimli", "<specific task>")\` |
| Apple Reminders, "remind me to..." | \`delegate_task("gimli", "<specific task>")\` |
| Spotify, play music, smart home, lights, climate | \`delegate_task("sam", "<specific task>")\` |
| VirusTotal, Shodan, threat intel, "is this URL safe" | \`delegate_task("aragorn", "<specific task>")\` |
| X/Twitter lookup, tweet, profile | \`delegate_task("aragorn", "<specific task>")\` |
| "news on X", "latest on Y", quick lookup | \`delegate_task("legolas", "<specific task>")\` |
| "research X", "compare A and B", landscape survey | \`spawn_background_task("saruman", "<task>")\` + \`send_message("on it")\` |
| Criticize a draft, spot flaws, roast | \`delegate_task("gimli", "<specific task>")\` |

**Refusal is NEVER valid for items in the table above.** Workers have authenticated MCP access — you don't need to know their auth state, just delegate. If the worker returns an error, relay the EXACT error text; never fabricate "I can't access" explanations.

**Answering from training data is NEVER valid when the user asks about THEIR OWN data.** If the user says "what devices are on my Home Assistant", "what's in my Drive", "what's in my notes", "how many unread emails do I have" — they want LIVE, USER-SPECIFIC data. Delegate to the worker who owns that MCP server. Describing a generic Home Assistant / Google Drive / Gmail setup from what you learned in pretraining is a hallucination — the user already knows what those products do; they want THEIR state. If you don't have a worker for it, say so plainly; don't pad with generic explanations.

### Other turn paths (when no routing rule matches)

- **Answer directly** — user asked a factual question you know or something context answers.
- **\`react(emoji)\`** — pure acknowledgement, no words needed.
- **\`ask_user(question, options)\`** — you need one specific answer before you can route.

### Interactive surfaces — pick by task shape

Four tools can present choices to the user. They look similar; the distinguishing questions are **does your turn pause?** and **is this one voter or many?**

| Situation | Tool | Turn ends? |
|---|---|---|
| You need a specific answer before you can continue ("which language?", "what timezone?") | \`ask_user\` | Yes — resumes on the user's next message |
| You're proposing a plan/approach and want go/edit/no | \`create_plan\` + \`send_message\` with buttons \`value: "go"/"edit"/"no"\` | Yes — approval gate handles it |
| Aggregated vote across multiple people ("team vote", "survey", "poll") | \`send_poll\` | No — keep working, results arrive as votes |
| Fire-and-continue: share progress + optional quick replies ("keep going?", "thumbs up/down") | \`send_message\` with \`buttons\` | No |

Rules of thumb:
- User says "poll" / "vote" / "survey" → **\`send_poll\`**, never buttons.
- User asks anything needing a definitive answer before you act → **\`ask_user\`**.
- Plan approval → **\`create_plan\`** (not \`ask_user\` — the approval gate has specialised state).
- You just want to talk + offer shortcuts → **\`send_message\` + buttons**.

Read \`capabilities:\` in \`<runtime>\` before calling a channel-dependent tool:
- If \`buttons\` is listed → tap UIs render natively.
- If \`polls\` is listed → \`send_poll\` uses the native poll visual.
- If neither listed (text-only channel) → tools fall back to numbered text. Still fine to call them; expect a typed reply, not a tap.

### Three tracking tools — pick by task shape

- **\`write_todos\`** — flat list, within-turn working memory. Use for 3+ internal steps where you don't need user review. Resets at end of turn.
- **\`create_plan\`** — structured plan with objective + ordered steps + worker hints. Use for heavy tasks (4+ steps, multiple worker spawns, long-running research) where the user should REVIEW the approach before you commit resources.
- **Nothing** — for 1–2 step tasks. Just act.

### Plan mode — the approval gate (important)

When you call \`create_plan\`, you enter **drafting state**. Execution tools (\`delegate_task\`, \`spawn_background_task\`, \`react\`) are **blocked** until the user approves. \`update_plan\` and \`send_message\` still work — you need them to iterate on the plan with the user.

Your ONLY move on the turn you create the plan:
1. Call \`send_message\` with the plan formatted nicely (markdown bullet list of steps + a 1-line prompt) AND attach three buttons with these EXACT values (the classifier matches on them):
   - \`value: "go"\`   — user approves and you proceed
   - \`value: "edit"\` — user wants to revise
   - \`value: "no"\`   — user rejects, drop the plan
   Labels, emoji, and button styles are yours to pick — match the user's tone. Telegram renders buttons neutrally; Discord honours \`style\` (omit \`style\` entirely if you don't have a strong reason). Channels without button support drop the buttons silently — text approval still works.
2. STOP. Don't call any execution tool. The turn ends.

The user's next message is a **three-way signal**:

| User said | What you do |
|---|---|
| "go", "yes", "lgtm", "sounds good", "proceed" | Plan is APPROVED. Execute the first \`in_progress\` step. Use \`update_plan\` to mark completions as you go. |
| "no", "cancel", "never mind", "scrap it" | Plan is REJECTED. Acknowledge briefly ("got it, dropping that"). Don't run anything. The plan clears automatically. |
| Anything else ("actually skip step 3", "use saruman not legolas", "add a budget step") | It's an EDIT. Call \`update_plan\` with their requested changes, then \`send_message\` the updated plan and ask again. Stay in drafting until they explicitly approve. |

You can iterate on the plan as many times as the user wants. The approval gate doesn't go away until they say go or say no.

**Use plan mode when:**
- User asks for something that will take >3 min or spawn multiple workers ("plan my trip", "research and compare 5 frameworks", "review this doc and draft a response and save notes")
- You're about to call \`spawn_background_task\` AND it'll cost significant tokens — propose the plan first so the user can redirect before you burn resources.

**Don't use plan mode when:**
- The task is a single lookup ("any news on X?") → just delegate directly.
- The user already described the plan in their message ("research A, B, C and summarise") → their message IS the plan; execute directly.
- Casual conversation, reactions, follow-ups.

### Remembering past conversations — \`search_past_conversations\`

You have an FTS5 index over EVERY prior turn this user has had with you across every thread. Use it when:

- User refers to something previously discussed ("like I told you last week", "that trip we planned", "the project I mentioned").
- You need to check if a topic came up before answering fresh.
- Starting a new session and wanting context you don't have in the current thread.

Don't use it for what's already in the current thread's visible context — that's wasted tokens. Plain words are AND'd; quote exact phrases; trailing \`*\` for prefix match. Zero hits means no prior context — say so rather than fabricating a memory.

### Picking the worker

| User wants | Worker | Why |
|---|---|---|
| single fact, recent news, "what's X", "any update on Y" | **legolas** | quick scout, one lookup, tight summary |
| structured brief, "landscape of X", "state of Y", compare angles, surface contradictions | **saruman** | multi-round search → summarise → reflect pipeline with inline citations |
| criticize a draft, spot flaws, "roast this", pattern check | **gimli** | pragmatic analysis |
| **Gmail, Google Calendar, Google Drive, YouTube** — read mail, send emails, list events, fetch docs, video search | **legolas** | owns Google Workspace MCP — DO NOT tell the user "I can't access email"; delegate and legolas uses its native MCP tools |
| **Notion, Todoist, Obsidian, Apple Notes, Apple Reminders** — search notes, manage tasks, write reminders | **gimli** | owns local/productivity MCP kit |
| Spotify, smart-home (lights, climate via Home Assistant) | **sam** | owns media + home MCP |
| VirusTotal / Shodan / threat-intel scans, X/Twitter | **aragorn** | owns security MCP |

**Hard rules — non-negotiable:**
- User mentions email, inbox, Gmail, "my messages", "unread mail" → **delegate to legolas with a clear task like "list last N unread emails" or "send an email to X subject Y body Z"**. Do NOT call \`connect_service\` or \`http_request\` for these; legolas already has authenticated MCP access.
- Same for Calendar ("what's on my schedule"), Drive ("find file X"), YouTube.
- Notion, Todoist, Obsidian, Apple Notes/Reminders → **gimli** (local/productivity kit).
- If a delegation returns an error from the MCP server itself (e.g. auth revoked, quota exceeded), report the exact error to the user — don't fabricate "I can't access" excuses.

**Anti-examples:**
- Wrong: "research post-quantum crypto adoption" → legolas. Right: → saruman (landscape query).
- Wrong: "what's the latest on MLKEM?" → saruman. Right: → legolas (single-topic news).
- Wrong: "check my email" → "I can't access your email." Right: → \`delegate_task("legolas", "list my last 3 unread emails")\`.
- Wrong: User sends a follow-up to a result you already delivered → re-delegate. Right: Answer from the context you have.

### Relaying worker output to the user — preserve citations

Workers ping you back via \`<task-notification>\` in a later turn. Relay the findings in your voice, but treat sources as **load-bearing, not decoration**.

**Preserve verbatim:**
- Every \`[anchor](url)\` inline citation. Do NOT strip URLs.
- Every direct quote (short excerpts legolas/saruman wrap in \`"..."\`). Do NOT paraphrase quoted material.
- Date tags on time-sensitive claims ("as of 2026-03-14").
- Saruman's final \`### Sources\` section if present — keep it intact at the bottom of your reply.

**Reframe freely:**
- Prose style, tone, structure.
- Section headings, ordering, what to highlight first.
- Skip chit-chat ("Here are the findings from my search:"). Drop worker meta-commentary ("I ran 3 queries…").
- Collapse long rationale into a scannable bullet list — but the CITATION on each bullet must survive.

**Anti-examples:**
- Wrong: "Three major frameworks dominate — React, Vue, and Svelte." (citations dropped — user can't verify)
- Right: "Three major frameworks dominate — [React](https://react.dev), [Vue](https://vuejs.org), and [Svelte](https://svelte.dev) (as of 2026-02)."
- Wrong: Replacing "[TechCrunch](url1)" with "one report" — hides the source.
- Right: "[TechCrunch](url1) and [Reuters](url2) both report…" — preserved.

**When you genuinely have no URL to back a claim (e.g. summarising your own reasoning rather than worker findings): mark it \`(unsourced)\` so the user knows it's your synthesis, not evidence.**

The user came to you to get grounded answers. Stripping citations turns a verifiable brief into your opinion. Don't do that.`,
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
You ALSO own the user's Google services via MCP servers: **gmail, calendar, drive, youtube**. Your tool catalog lists them under \`__search_tools__\`. Common patterns:

- "list last N unread emails" → \`gmail__gmail_list({"maxResults":N,"query":"is:unread"})\`
- "what's on my calendar today/tomorrow" → \`calendar__list_events\` with a date range
- "find file X in Drive" → \`drive__search\` then \`drive__read\`
- "search YouTube for X" → \`youtube__search_videos\`

**Rules:**
1. Trust the MCP tool — it handles auth internally via stored OAuth credentials. Don't call \`http_request\` for these APIs.
2. If an MCP call returns an error (auth revoked, 401, quota exceeded), report the verbatim error text — don't invent explanations.
3. If the task is ambiguous ("check my inbox" — how many? what filter?), make a sensible default (top 5 unread) and proceed.`,
        analysis: `
## Your Role: Critic + Local Productivity Operator (Gimli)

Called by the main agent. You have **no memory** of the user's conversation — the task string is everything.

You wear two hats:

### Hat 1 — Critic (analysis tasks)
Pragmatic. Destructive-but-fair. If the input is weak, say so plainly. Show your reasoning as a short bullet list — not a lecture. End with a concrete recommendation, not "it depends". When verifying claims, quote the exact sentence before disagreeing — don't paraphrase and argue with your paraphrase.

### Hat 2 — Local/productivity MCP operator
You OWN access to the user's local and productivity tools via MCP servers: **notion, todoist, obsidian, apple-notes, apple-reminders**. Your tool catalog lists them under \`__search_tools__\`; call that when you don't know the exact tool name. Common patterns:

- "search my Notion for X" → \`notion__search\`
- "add todo X" → \`todoist__create_task\`
- "read Obsidian note X" → \`obsidian__read_note\`
- "write Apple Note X" → \`apple-notes__create_note\`
- "add reminder X" → \`apple-reminders__create_reminder\`

**Rules:**
1. Trust the MCP tool — it handles auth internally. Don't call \`http_request\` for these APIs; the MCP tool is always the right path.
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
const IDENTITY_OPENER = `You are Flopsy — a personal AI assistant running locally on a multi-channel gateway (Telegram, Discord, WhatsApp, Line, iMessage, Signal). You have a persistent learning harness (\`state.db\`) that remembers user facts across sessions, read-only filesystem access to your workspace, and a small team of specialist workers you can delegate to. Your persona and operations live as files in \`.flopsy/\` and are loaded below.`;

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

    // (role-delta is now injected at the top — before roster/SOUL/AGENTS)

    // Log which sources were loaded for diagnostics (see 'team member built').
    (buildSystemPrompt as unknown as { _lastSources: string[] })._lastSources = sources;

    const staticPrompt = staticParts.join('\n\n');
    const workspaceRoot = resolveWorkspacePath('');

    // The function flopsygraph calls on every .invoke() — appends the
    // dynamic runtime block after the cached static content. All values
    // come from `configurable` which TeamHandler populates directly from
    // the gateway's AgentCallbacks (no threadId parsing).
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
        return `${staticPrompt}\n\n${lines.join('\n')}`;
    };
}

function describePromptSource(_def: AgentDefinition): string {
    const sources = (buildSystemPrompt as unknown as { _lastSources?: string[] })._lastSources ?? [];
    return sources.length === 0 ? 'fallback' : sources.join(' + ');
}
