# flopsygraph memory — any-provider pluggable seam

Status: solution design. Answers: "can flopsygraph's memory seam be adapted to use ANY
provider (mem0 / Honcho / Zep / Letta / file / sqlite)?" — Yes. Here's how.

Grounded in: `flopsygraph/src/memory/{types.ts,registry.ts}` (read directly),
`/tmp/external-memory-providers.md` (mem0/Honcho/Zep/Letta API shapes),
`/tmp/flopsybot-memory-current.md` (FlopsyBot wiring).

## Where things stand

**FlopsyBot uses flopsygraph's memory *types*, not its *registry*.**
`FileMemoryProvider` implements flopsygraph's `MemoryProvider` interface, but FlopsyBot
hard-constructs it at `factory.ts:276` and never calls `getMemoryRegistry().load()`. So
the pluggable loader exists and is bypassed.

**The pluggability infrastructure is already done and is good:**
- `MemoryRegistry` (`registry.ts`): `register(manifest)` + config-driven `load(config, deps)`.
- `ProviderManifest`: `{ name, version, capabilities, factory, validateConfig }` — config
  validated at startup, `factory` builds the provider, `ping()` health-gates before any
  agent turn.
- Built-ins auto-register (sqlite=`local`, in-memory); peer-dep stores (postgres/redis/
  dynamodb) register explicitly so install footprint stays minimal.
- `MemoryConfig = { enabled?, provider?, config? }` — one config key selects the backend.
- `enabled:false` → `DisabledProvider` no-op. Clean.

Adding a new provider is already just: `getMemoryRegistry().register(mem0Manifest)` +
`memory.provider: "mem0"` in config. **The loader doesn't need to change.**

## What blocks "any provider" today

The blocker is the **`MemoryProvider` interface is too thin and too tool-centric**:

```ts
interface MemoryProvider {
  name; capabilities?; card?;
  ping(): Promise<{ok, reason?}>;
  getTools(): readonly BaseTool[];   // ← the ONLY way a provider does anything
}
```

`getTools()` means "the provider hands the model tools; the model calls them." That fits
**archetype A** stores ("tell me what to store" — file, sqlite, Letta blocks). It does
NOT fit **archetype B** providers ("I'll extract from the conversation" — mem0 default,
Honcho, Zep), which want three things this interface can't express:

1. **Message ingestion** — mem0/Honcho/Zep take `[{role,content}]` + a scope id and
   auto-extract facts. There's no `add(messages)` path; `getTools()`-driven `add(content)`
   forces the model to pre-digest, defeating the provider's whole value.
2. **Context injection** — the file provider's `.md` contents reach `<agent_memory>` via a
   FlopsyBot-specific interceptor, NOT through the interface. A vector/Zep/Letta provider
   has no way to contribute injected context (Zep returns a context *string*; Letta has
   in-context *blocks*; mem0 returns top-K *memories*).
3. **Multi-axis scope** — the interface offers `namespace` (one string). mem0 *requires*
   `user_id` (calls fail without it) and also uses `agent_id`/`run_id`. One string can't
   carry that.

## The solution: capability-rich optional hooks (backward-compatible)

Evolve `MemoryProvider` so each provider implements **only what it supports**; the host
checks for the method and adapts. This is exactly how Hermes (`MemoryProvider` ABC: 4
required + ~10 optional hooks) and openclaw (`MemoryPluginCapability` four-slot bag) do
it. Every new method is **optional** → existing providers keep working untouched.

```ts
type MemoryScope = {
  userId?: string; agentId?: string; sessionId?: string;
  threadId?: string; namespace?: string;
};

type RecallResult = {
  results?: MemoryResult[];   // ranked items (mem0, vector, sqlite)
  context?: string;           // pre-bundled context block (Zep memory.get, Honcho session.context)
};

interface MemoryProvider {
  readonly name: string;
  readonly capabilities?: readonly MemoryCapability[];
  readonly card?: string;
  ping(): Promise<{ ok: boolean; reason?: string }>;

  // ── Recall surface — implement one or more ────────────────────────────
  getTools?(): readonly BaseTool[];                          // EXISTING (now optional): model-driven recall/edit tools
  recall?(scope: MemoryScope, opts: SearchOptions): Promise<RecallResult>;  // host-driven recall
  getInjectedContext?(scope: MemoryScope): Promise<string>;  // what to splice into <agent_memory>

  // ── Capture surface — implement one or more ───────────────────────────
  ingestTurn?(messages: ChatMessage[], scope: MemoryScope): Promise<void>;  // archetype B: feed the raw turn, provider extracts
  save?(facts: string[], scope: MemoryScope): Promise<void>;                // archetype A: explicit host-driven save
}
```

Add a capability flag so the host knows the archetype without probing:
`MemoryCapability` gains `'turn_ingestion'` (provider auto-extracts from messages) and
`'context_injection'` (provider contributes a `<agent_memory>` block).

### Backward compatibility (proof)
Existing providers — sqlite, in-memory, postgres, redis, dynamodb, FileMemoryProvider —
implement `ping()` + `getTools()` only. All new methods are optional. They compile and
behave identically. **Zero migration for the five built-ins.** The interface change is
purely additive.

## Per-provider adapter map

Each external provider is a thin class implementing only the hooks it needs, registered
via a manifest (`validateConfig` checks the API key). The adapter translates the hook
to the provider's SDK call:

| Provider | archetype | getInjectedContext | ingestTurn | recall | getTools | save |
|---|---|---|---|---|---|---|
| **file** (FlopsyBot) | A | `.md` contents | — | — | optional `remember` | append+dedup in code |
| **sqlite/pg/redis/dyn** (existing) | A | — (or top-K) | — | `search()` | existing tools | `add()` |
| **mem0** | B | top-K `search()` as block | `add(messages,{user_id})` | `search()→results` | — | `add(facts,{infer:false})` |
| **Honcho** | B | `session.context()` bundle | `session.addMessages()` | `peer.chat()`→`context` | — | — |
| **Zep** | B | `memory.get()`→`context` | `memory.add(messages)` | `graph.search()→results` | — | — |
| **Letta** | A | core memory blocks | — | (archival, optional) | block update tool | `blocks.update()` |

mem0's `add` takes a `messages` array + required `user_id` — `MemoryScope.userId` maps
straight onto it. Zep/Honcho return a context *string* — `RecallResult.context` carries
it. Letta's always-in-context blocks → `getInjectedContext`. No interface gymnastics; the
union of optional hooks covers every archetype.

## Host orchestration (who calls what, when)

The host (flopsygraph executor, or FlopsyBot's turn loop) drives the provider — the
**model never has to choose how to persist**:

1. **Before model call** — if `provider.getInjectedContext` exists, call it and splice
   into `<agent_memory>`. (Replaces the file-only interceptor; now provider-agnostic.)
2. **Mid-turn recall** — expose `provider.getTools()` if present (model calls `search`
   when it needs a fact), OR the host calls `provider.recall()` and injects results. For
   small-file providers neither is needed — the facts are already injected.
3. **After the turn (off hot path)** — if `provider.ingestTurn` exists, feed the just-
   finished turn (archetype B auto-extracts → **zero model write-cost**). If only `save`
   exists, a background extractor (Hermes-style fork) produces candidate facts and calls
   `save()`; dedup/merge happen in the provider's code, not the model's reasoning.

This is the same recall=model / save=host split both reference harnesses converged on —
now expressed once at the interface, honored by every provider.

## Does it improve memory? (goal gate)

Yes:
- **Use any backend by config**: `memory.provider: "mem0" | "honcho" | "zep" | "letta" |
  "file" | "local"`. Exactly "I need to use any memory for flopsygraph."
- **Archetype-B providers eliminate model write-cost outright** — mem0/Honcho/Zep extract
  from the turn themselves. The "paragraphs to save I-live-in-Goma" problem disappears
  because the model isn't in the write path at all.
- **Injection becomes provider-agnostic** (`getInjectedContext`) — fixes today's
  file-only path and lets Zep/Letta/vector contribute context.
- **Backward-compatible** — the five built-ins need no changes.
- One-external-provider-max rule (Hermes) keeps tool-schema bloat out.

## Plan

**Phase A — extend the interface (additive, no behavior change).**
Add the optional hooks (`recall`, `getInjectedContext`, `ingestTurn`, `save`),
`MemoryScope`, `RecallResult`, the two new capability flags. Built-ins untouched. ~1 day.

**Phase B — host orchestration in flopsygraph.**
A small `MemoryHost` that, given a loaded provider, runs the inject-before / recall-mid /
ingest-after lifecycle. Wire FlopsyBot's `factory.ts:276` through
`getMemoryRegistry().load(config.memory)` + `MemoryHost` instead of the hard-constructed
tool. Make `FileMemoryProvider` implement `getInjectedContext` + `save`. ~3 days.

**Phase C — first external adapter proves the seam.**
Implement the **mem0** adapter (most-used, has a TS SDK `mem0ai`, both embedded and
managed). Register its manifest with `validateConfig` (API key / base URL). Flip
`memory.provider: "mem0"` and confirm zero model write-cost. ~2-3 days.

**Phase D — additional adapters as needed** (Honcho/Zep/Letta), each a thin manifest +
adapter class. ~1 day each.

Net: flopsygraph gets a true any-provider memory seam; FlopsyBot stops bypassing it; and
the archetype-B providers deliver the low-write-cost win for free.
