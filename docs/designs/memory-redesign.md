# Memory redesign — lower write-cost + pluggable providers

Status: plan. Grounded in deep-reads of hermes-agent and openclaw memory internals
(`/tmp/hermes-memory-deep.md`, `/tmp/openclaw-memory-deep.md`) and a full map of
FlopsyBot's current memory layer (`/tmp/flopsybot-memory-current.md`).

## The problem, stated precisely

Saving a trivial fact ("I live in Goma") costs the model paragraphs of reasoning.
The cost lives entirely in the **model-facing write surface**: before any save the
model must decide (1) `target` user vs memory, (2) which of 5 `action`s
(list/add/upsert/replace/remove), (3) whether a prior entry exists or it gets
refused, (4) for upsert: invent a `key`, (5) for replace/remove: craft a unique
`old_text`. Dedup, categorization, and budget enforcement — all clerical, all
delegated to the LLM, all on the live conversation turn.

My earlier session made this *worse*: I added `upsert` and `list` (3 verbs → 5),
improving correctness while increasing the decision surface. Wrong axis.

## What the references actually do (premise correction)

I assumed the references "collapse to one verb." They don't. The win is elsewhere.

**Hermes** (`tools/memory_tool.py`, `agent/background_review.py`):
- The memory tool still has 3 verbs (add/replace/remove) + target + old_text — a
  surface nearly as wide as FlopsyBot's.
- The real win: **writes are offloaded to a forked background agent.** A counter
  (`_turns_since_memory >= N`, `conversation_loop.py:429`) fires *after the response
  ships*, spawning a daemon-thread agent (memory/skill tools only) that inherits the
  parent's cached prompt (~26% cache win). **The live user turn pays zero memory-write
  cost.**
- Code owns dedup: `add` rejects exact duplicates *as a success*; the file is
  order-preserving-deduped on load (`dict.fromkeys`). The model never reasons about it.
- Frozen-snapshot: memory injected at session start, never mutated mid-session.
- Char-based caps, code-enforced. Model sees a budget error only on overflow.
- Pluggable: `MemoryProvider` ABC (4 required methods + ~10 optional hooks),
  `MemoryManager` fans events to providers, **one-external-provider-max rule** to
  prevent tool-schema bloat. 8 bundled providers (honcho, mem0, …).

**Openclaw** (`extensions/memory-core/`, `src/plugins/memory-state.ts`,
`src/auto-reply/reply/agent-runner-memory.ts`):
- **Save is host-driven; recall is a model tool.** `memory-core` exposes NO write
  tool — only `memory_search` + `memory_get`. Saving is a pre-compaction lifecycle
  turn: `runMemoryFlushIfNeeded` detects a threshold, creates `memory/YYYY-MM-DD.md`,
  runs one extra agent turn with a prescriptive append-only prompt ("if nothing to
  store reply `<silent>`"). **Per-turn cost of remembering during dialogue: zero.**
- Recall asymmetry: recall is on the hot path (only the model knows mid-turn it needs
  a fact); save isn't time-sensitive, so it's batched off the turn.
- Storage: plain markdown, `MEMORY.md` loaded whole in fixed concat order; dated
  `memory/*.md` append-only, reachable via search. No surgical edits; dups tolerated
  and consolidated by an offline sweep.
- Pluggable: `MemoryPluginCapability` four-slot bag — `promptBuilder` (recall
  teaching), `flushPlanResolver` (the save seam — returns a *plan*, not a save fn),
  `runtime` (search backend), `publicArtifacts`. Registered via
  `api.registerMemoryCapability`. A vector provider (`memory-lancedb`) DOES expose
  store/forget tools + in-code cosine dedup + auto-capture/recall lifecycle hooks.

### The convergent principle both share

**RECALL is a model concern (hot path, mid-turn, cheap). SAVE is a system/background
concern (not time-sensitive — take it off the turn).** FlopsyBot does the opposite:
every save is an inline 5-verb tool call the model reasons through. That single
inversion is the entire cost.

## What FlopsyBot already has (the lucky part)

- **The pluggability seam already exists in flopsygraph and is unused.**
  `flopsygraph/src/memory/{types.ts,registry.ts}` define `MemoryProvider`,
  `ProviderManifest`, and `MemoryRegistry`/`getMemoryRegistry().load(config)` with 5
  reference backends (sqlite/in-memory/postgres/redis/dynamodb). `FileMemoryProvider`
  already implements `MemoryProvider`. FlopsyBot bypasses all of it — `factory.ts:276`
  hard-constructs `createMemoryTool` directly.
- **A post-turn background mechanism already exists**: `SessionExtractor`
  (`harness/review`) mines *skills* on session close. The same fork can extract
  *memory facts* — that's Hermes's background-review pattern, half-built.
- **A compaction hook exists** (the compactor) — openclaw's save-before-compaction
  slot maps onto it.

So both winning patterns have a foundation already in the codebase.

## Recommended design

Principle: **take the write off the live turn; make recall free for the common case;
route everything through the existing registry so it's pluggable.**

### Recall (model, hot path)
- Small files (USER.md/MEMORY.md under budget) stay injected in the prompt as today.
  Recall is **free** — no tool, the facts are already in context. This is 95% of cases.
- When memory exceeds context (dated files, vector backend), the provider contributes
  a `memory_search`/`memory_get` recall tool + a recall-teaching prompt block
  (openclaw's `promptBuilder`). Provider-dependent, off by default.

### Save (system, off hot path)
- The live model does **not** call surgical write verbs during normal conversation.
- A **post-turn memory extractor** (fork, Hermes-style; extend `SessionExtractor` or
  add a memory-review fork) reads the finished turn and decides what to persist. It
  does dedup / merge / categorize / budget **in code**.
- Optional single `remember(text)` verb for explicit "remember this" — but it only
  *queues* the fact for the background writer; the writer does the bookkeeping. The
  model's whole job is the fact text. (Or omit the write tool entirely and rely on
  extraction, openclaw-style. Decide in Phase 2.)
- Host owns *when* (post-turn + pre-compaction flush) and *policy* (append-only,
  dedup, budget); model owns only *what*.

### Pluggability
- Route construction through `getMemoryRegistry().load(config.memory, deps)`. Register
  `FileMemoryProvider` as the default manifest. sqlite/vector/mem0/honcho become
  alternates selected by `config.memory.provider`.
- Extend `MemoryProvider` with a provider-agnostic capability set covering both
  file-style and vector-style backends (modeled on openclaw's four-slot bag):
  - `getInjectedContext(): Promise<string>` — what goes in the `<agent_memory>` block
    (file → the .md contents; vector → a recall-hint block). Replaces the
    file-specific `agentMemory` interceptor path.
  - `recallTools(): BaseTool[]` — empty for small-file; `[search, get]` for vector.
  - `save(turn, candidateFacts): Promise<void>` — host-driven; file appends+dedupes,
    vector embeds+dedupes. **This is where the clerical work moves out of the model.**
  - `flushSignals()` — when the host should trigger a save pass.
- **One-external-provider-max rule** (Hermes) to prevent tool-schema bloat.

## Does it improve memory? (the goal's gate)

Yes, concretely and measurably:
- **Live-turn write cost: 5-verb decision → ~zero.** The model states facts in normal
  prose; the background extractor persists them. Directly fixes "saving I live in Goma
  costs paragraphs."
- **Dedup / categorize / budget: model → code.** No more triple `Location: Congo`, no
  more user-vs-memory agonizing per save.
- **Writes become visible same-session** once the injection cache bug is fixed
  (`agent-memory.ts` caches on first model call — currently a write isn't seen until a
  fresh agent).
- **Pluggable**: file today, vector/mem0/honcho tomorrow, via a seam that already
  exists — minimal new surface.

## Plan (phased)

**Phase 0 — migrate the live confused data (cheap, immediate relief).**
The live `state/memory/USER.md` still carries a stale 43-line section-skeleton template
(treated as entry #0, eating the budget) + mis-filed "Building Bytepesa" + a `test`
entry. The *seed* is already a bare H1 (good), so this is data-only: strip the template
remnant, move Bytepesa → MEMORY.md, dedup `Location`, drop `test`. ~1 hr.

**Phase 1 — route through the registry (pluggability foundation, no model-surface change).**
- `factory.ts:276` → `getMemoryRegistry().load(config.memory, deps)`.
- Register `FileMemoryProvider` as a manifest; populate `opts.memoryStore` (already
  plumbed at `factory.ts:209/607`).
- Add `getInjectedContext()` to `MemoryProvider`; make the `<agent_memory>` injection
  provider-agnostic (so non-file backends work).
- Fix the `agent-memory.ts` first-call cache so tool/background writes are visible.
- Retire or re-point the dormant `memory.db` + CLI. ~2-3 days.

**Phase 2 — take writes off the hot path (the big win).**
- Build the post-turn memory extractor (fork; extend `SessionExtractor`).
- Move dedup/merge/categorize/budget into `provider.save()` (code).
- Collapse the model-facing write surface to a single optional `remember(text)` that
  queues for the background writer — or remove it entirely (extraction-only). Keep
  recall as injection (no recall tool for small files).
- Update `MEMORY_GUIDANCE` (currently stale: documents 3 actions, tool has 5). ~4-5 days.

**Phase 3 — prove pluggability with a second provider.**
- Formalize the capability contract (inject/recallTools/save/flushSignals).
- Wire one alternate: either the dormant flopsygraph `sqlite` provider or a vector
  provider (mem0/lancedb-style) with search/get tools + auto-capture hooks.
- One-external-provider-max enforcement. ~3-4 days.

Phase 0 is independent and gives immediate relief; everything else builds on Phase 1.

## Open decisions for the user
1. **Write tool: keep a single `remember(text)` or go extraction-only (no write tool)?**
   Hermes keeps a (background-only) tool; openclaw has none for files. `remember(text)`
   is more responsive to explicit "remember this"; extraction-only is the lowest model
   surface. Recommendation: keep `remember(text)` as a queue-only verb.
2. **One store or two?** Keep USER.md/MEMORY.md split (system auto-routes in
   `save()` by fact shape) vs collapse to one. Recommendation: keep two, auto-route in
   code so the model never picks — preserves a human-readable USER.md.
3. **Which second provider proves the seam in Phase 3** — revive flopsygraph sqlite, or
   add a vector/mem0 provider?
