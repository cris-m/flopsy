# flopsygraph memory — the rethink (investigation)

Status: investigation + design direction. Supersedes the incremental "route through the
existing registry" approach. Grounded in direct reads of
`flopsygraph/src/memory/{types.ts,registry.ts,tools.ts}` and
`flopsygraph/src/prebuilt/interceptors/agent-memory.ts`.

## The core finding: memory is TWO disconnected mechanisms

flopsygraph doesn't have *a* memory system — it has two that don't know about each other:

1. **Provider + tools** (`MemoryProvider.getTools()` → `tools.ts`
   `StandardMemoryToolsImpl`: `search / add / replace / remove / listNamespaces`).
   Model-driven, surgical, archetype-A ("tell me what to store"). The model calls
   `add`/`replace` with a `namespace` + a `target` substring. **The model pays the
   write cost** — same design as FlopsyBot's file tool, just at the library layer.

2. **Injection** (`agent-memory.ts` interceptor). Reads **file paths from disk**
   (`sources: Array<string | {hostPath, virtualLabel}>`), wraps them in
   `<agent_memory>`. **File-only by construction** — there is no provider hook. A
   sqlite/vector/mem0 provider has *no way to put anything in the prompt*.

These two never connect. The provider gives tools; the interceptor reads files. A
provider can't contribute injected context; the injector can't read a non-file store.
That gap is why "pluggable to any provider" doesn't actually work today — you can swap
the *tool* backend, but a non-file backend goes silent at injection time.

## What neither mechanism supports

- **Archetype-B capture** — mem0/Honcho/Zep take `[{role,content}]` messages and extract
  facts themselves. There is no `ingest(messages)` anywhere. `add(content)` forces the
  model to pre-digest, which defeats those providers and keeps the cost on the model.
- **Provider-driven injection** — Zep returns a context string, Letta has in-context
  blocks, mem0 returns top-K. None can reach the prompt; injection only reads files.
- **recall-as-tool / save-as-host split** — both reference harnesses (Hermes background
  fork, openclaw pre-compaction flush) take *save* off the live turn. flopsygraph has no
  seam for that; save is always a model tool call.
- **Multi-axis scope** — `SearchOptions.namespace` is one string. mem0 *requires*
  `user_id` (+ `agent_id`/`run_id`); one namespace can't carry it.

So the right move is **not** "add optional hooks to `MemoryProvider`" (my earlier doc —
too incremental; it leaves the two mechanisms split). It's:

## The rethink: the provider owns the whole memory lifecycle

Unify recall + injection + capture under one provider contract, with the executor
orchestrating *when*. The provider becomes the single source of truth for "what is in
memory and how it reaches the model." The file-only injector is replaced by a
provider method.

```ts
interface MemoryProvider {
  readonly name: string;
  readonly capabilities?: readonly MemoryCapability[];
  ping(): Promise<{ ok: boolean; reason?: string }>;

  // INJECT — provider contributes its own context block. Replaces the
  // file-only agent-memory interceptor. File provider returns its .md;
  // Zep returns memory.get(); Letta returns core blocks; mem0 returns top-K;
  // a pure-search store returns "" and relies on recall tools instead.
  contributeContext?(scope: MemoryScope): Promise<string>;

  // RECALL — optional on-demand search tools, for when memory exceeds the
  // context window. Empty for small-file providers (already injected).
  recallTools?(): readonly BaseTool[];

  // CAPTURE — host-driven, OFF the live turn. Archetype-A providers append
  // facts; archetype-B providers (mem0/Honcho/Zep) take the raw turn and
  // extract. Either way the live model is not in the write path.
  ingest?(input: IngestInput, scope: MemoryScope): Promise<void>;

  // Back-compat: existing surgical tools. Deprecated in favor of host-driven
  // ingest, kept so the 5 built-ins keep working unchanged.
  getTools?(): readonly BaseTool[];
}

type MemoryScope = { userId?; agentId?; sessionId?; threadId?; namespace? };
type IngestInput =
  | { kind: 'messages'; messages: ChatMessage[] }   // archetype-B: provider extracts
  | { kind: 'facts'; facts: string[] };             // archetype-A: store verbatim
```

And a thin **`MemoryHost`** in the executor (not the model) that runs the lifecycle:
- **before model call** → `contributeContext(scope)` → splice into `<agent_memory>`
  (replaces the interceptor for *memory* files).
- **mid-turn** → expose `recallTools()` if any.
- **after the turn (off hot path)** → `ingest(...)`. Host owns *when* (post-turn and/or
  pre-compaction); provider owns *how* (extract vs append, dedup in code).

### Key separation this forces: identity files ≠ memory

Today `factory.ts:573` lumps `SOUL.md` + `USER.md` + `MEMORY.md` into one `agentMemory`
interceptor. They're different kinds of thing:
- **SOUL.md / AGENTS.md** = static identity/rules → stay on the file interceptor.
- **USER.md / MEMORY.md** = dynamic memory → move to the provider's `contributeContext`.

This is why a vector/mem0 backend can replace USER.md/MEMORY.md without touching the
identity files. The rethink draws that line; the current code doesn't.

## Why this is the right layer

- It makes **injection provider-agnostic** — the missing half of "pluggable."
- It bakes the **recall=tool / save=host split** into flopsygraph for *every* provider,
  so the low-write-cost win isn't a FlopsyBot special case.
- It's **backward-compatible**: `getTools()` stays (the 5 built-ins implement only
  `ping`+`getTools` and keep working); `contributeContext`/`recallTools`/`ingest` are
  optional; the file interceptor still serves SOUL/AGENTS.
- archetype-B providers (mem0/Honcho/Zep) become first-class: `ingest({kind:'messages'})`
  hands them the turn, they extract — **model write-cost goes to zero**, which is the
  original "paragraphs to save I-live-in-Goma" complaint, solved at the library.

## How FlopsyBot consumes it (the "then improve flopsybot" half)

Once flopsygraph exposes this contract:
1. FlopsyBot loads its provider via the registry (the seam I half-wired this session —
   `loadMemoryProvider` + `fileMemoryProviderManifest`).
2. `FileMemoryProvider` implements `contributeContext` (its .md) + `ingest({facts})`
   (append+dedup in code) + optional `remember` recall. It drops the 5-verb model tool.
3. The executor's `MemoryHost` injects USER.md/MEMORY.md via `contributeContext`;
   SOUL.md/AGENTS.md stay on the existing interceptor.
4. Switching `memory.provider: "mem0"` swaps in turn-ingestion + auto-extract with no
   FlopsyBot changes — the model never touches a memory verb.

## Open questions to resolve before building

1. **Does `MemoryHost` live in flopsygraph's executor or in FlopsyBot's turn loop?**
   In the executor = every flopsygraph consumer benefits; in FlopsyBot = faster to ship
   but not reusable. Lean: executor, behind a capability flag so non-memory graphs skip it.
2. **When does `ingest` fire?** Post-every-turn (responsive, more LLM calls if the
   provider extracts via LLM) vs pre-compaction (cheap, delayed) vs a turn-counter
   (Hermes). Provider should be able to declare its preference.
3. **Scope source** — where does `MemoryScope` come from? `ExecutionContext.configurable`
   already carries `userId`/`threadId`; add `agentId`/`sessionId` there.
4. **Migration of the 5 built-ins** — they keep `getTools()`; do we also give sqlite a
   `contributeContext` (top-K) so it can inject, or leave it recall-only?

## Build progress (this session)

Phases 0–2 + 3a are implemented and compiling (additive; the 5 built-ins and all
existing behavior are untouched):

- **Phase 0 (validate)** — contract checked against mem0 (`add(messages,{user_id})` /
  `search`→ranked), Zep (`memory.get`→context string), Letta (core blocks), file. Fits.
- **Phase 1 (interface)** — `flopsygraph/src/memory/types.ts`: added `MemoryScope`,
  `IngestInput` (messages | facts), `RecallBundle`, `MemoryArchetype`, optional
  `contributeContext` / `recallTools` / `recall` / `ingest` on `MemoryProvider`, and
  `turn_ingestion` / `context_injection` capability flags. Built-ins compile unchanged.
- **Phase 2 (MemoryHost)** — `flopsygraph/src/memory/host.ts`: `getInjectedContext` /
  `recallTools` / `captureTurn`, fail-safe, with a `FactExtractor` seam for store
  providers. Exported from the barrel.
- **Phase 3a (FileMemoryProvider)** — implements `archetype:'store'`,
  `contributeContext()` (USER.md+MEMORY.md), `ingest({facts})` (append + exact-dedup +
  budget, in code). The clerical work is now in the provider, not the model.

**Remaining = activation, and it changes runtime behavior — validate against a running
gateway.** Phase 3b: (a) call `MemoryHost.getInjectedContext` when building the prompt and
move USER.md/MEMORY.md off the file interceptor into provider-driven injection (SOUL.md/
AGENTS.md stay on the interceptor); (b) call `MemoryHost.captureTurn` post-turn with a
`FactExtractor` (the background LLM pass), so the model stops calling the write tool.
Phase 4: the mem0 adapter. Both touch the injection path — exactly where the prior
caching/dual-injection memory bugs lived — so they should land with the gateway up to
observe the actual `<agent_memory>` block, not blind.

## Status of this session's earlier partial wiring

The registry-routing pieces are in place and compiling, but **not activated** (no call
site passes `memoryStore`, so the factory still falls back to direct file-tool
construction — behavior unchanged):
- `fileMemoryProviderManifest` + `loadMemoryProvider` (src/team/src/memory)
- `TeamHandler.getMemoryProvider()` (memoized, fail-safe)
- factory sources memory tools from `opts.memoryStore` when present

This is a safe checkpoint. If we adopt the rethink, the provider contract changes
(adds `contributeContext`/`ingest`), so the wiring should be *finished against the new
contract*, not the old `getTools()`-only one. Recommend: design the contract first
(this doc), then wire once.
