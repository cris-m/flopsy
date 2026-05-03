# Architecture

FlopsyBot is a single-process daemon that multiplexes many chat channels into one reasoning agent (with optional delegation to worker agents). This document explains the main components, how they fit together, and where state lives.

## Process model

One long-running Node process — the **gateway** — is the whole product. It hosts:

- N channel adapters (one per enabled channel)
- The agent team (main + workers)
- The proactive engine (heartbeats, cron, inbound webhooks)
- The management HTTP endpoint (for `flopsy mgmt`)
- Persistent storage handles (three SQLite databases + workspace files)

```mermaid
flowchart TB
  subgraph GATEWAY["Gateway process (Node)"]
    direction TB
    subgraph ADAPTERS["Channel adapters"]
      TG[telegram]
      DC[discord]
      LN[line]
      WA[whatsapp]
      SL[slack]
      IM[imessage]
      SG[signal]
      GC[googlechat]
    end
    ROUTER[Router / Handler]
    TEAM[Agent team]
    PROACTIVE[Proactive engine]
    MGMT[Management HTTP<br/>127.0.0.1:18790]

    ADAPTERS -.inbound.-> ROUTER
    ROUTER --> TEAM
    TEAM --> ROUTER
    ROUTER -.outbound.-> ADAPTERS
    PROACTIVE --> TEAM
  end

  STATE[(state.db)]
  MEM[(memory.db)]
  CKPT[(checkpoints.db)]
  CONFIG[flopsy.json5]
  ENV[.env]

  GATEWAY -->|reads| CONFIG
  GATEWAY -->|reads| ENV
  TEAM <-->|per turn| STATE
  TEAM <-->|per turn| MEM
  TEAM <-->|on pause| CKPT
```

### Why a single process?

- **Context locality.** All channel state, memory, and agent reasoning sit in the same address space — no cross-process IPC for the hot path.
- **Simpler ops.** One binary, one log, one pid, one `flopsy gateway restart`.
- **Cheap to scale vertically.** FlopsyBot is designed to run on a $5 VPS — not a Kubernetes cluster.

When you outgrow the single process, the seam is the channel adapter: move an adapter to its own process and talk to the gateway over the management HTTP endpoint.

## Data flow: an inbound turn

```mermaid
sequenceDiagram
    actor User
    participant Adapter as Channel adapter
    participant Router
    participant Team as Agent team (main)
    participant LLM as LLM provider
    participant Tools
    participant DB as state.db / memory.db

    User->>Adapter: "what's on my calendar tomorrow?"
    Adapter->>Router: normalised message
    Router->>Team: invoke(thread_id, text)
    Team->>DB: load thread history + user memory
    Team->>LLM: system prompt + history + current turn
    LLM-->>Team: decision (tool call or answer)
    alt Tool call
      Team->>Tools: delegate_task / send_message / ...
      Tools-->>Team: result
      Team->>LLM: history + tool result
      LLM-->>Team: final answer
    end
    Team->>DB: persist turn + new facts
    Team->>Router: send_message(channel, peer, text)
    Router->>Adapter: outbound
    Adapter->>User: reply
```

Key properties of this loop:

- **Thread-scoped.** Every peer on every channel gets its own thread id. Threads don't leak across peers.
- **Checkpointed.** If the LLM call fails mid-turn, the half-turn is saved in `checkpoints.db` so it can resume after restart instead of replaying from scratch.
- **Observable.** Every step is logged with a correlation id so you can reconstruct a turn after the fact.

## Core subsystems

| Subsystem | Source location | Responsibility |
|---|---|---|
| Gateway | `src/gateway/` | Boots channel adapters, hosts router, runs mgmt HTTP |
| Team | `src/team/` | Builds agents from config, runs the react loop, owns tools |
| Shared | `src/shared/` | Config loader, workspace paths, logger, SQLite helpers |
| App | `src/app/` | `npm start` entry point — wires gateway + team |
| CLI | `src/cli/` | The `flopsy` binary (this doc suite) |

## Configuration layers

```
flopsy.json5   ─┐  JSON5 with comments. Shape validated by Zod.
                │  Env vars interpolated: ${FOO} / ${FOO:-default}.
.env           ─┤  Secrets (bot tokens, API keys).
                │  Auto-loaded from the directory containing flopsy.json5.
FLOPSY_HOME   ─┤  Absolute path to the workspace. Default: ./.flopsy
FLOPSY_CONFIG ─┘  Absolute path to a non-default config.
```

Precedence (highest wins):

1. `FLOPSY_CONFIG` env var → explicit path
2. Walk up from cwd for `flopsy.json5`
3. Walk up from CLI install location (for `flopsy` run outside the project)

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Booting
    Booting --> Starting: config valid
    Starting --> Running: adapters connected
    Running --> Draining: SIGTERM / flopsy gateway stop
    Draining --> Stopped: in-flight turns finish
    Stopped --> [*]
    Booting --> Stopped: config error
    Running --> Running: hot edits<br/>(skills reload without restart)
```

- **Booting**: load `.env`, parse config, initialize loggers + databases.
- **Starting**: spawn channel adapters, open MCP servers, bind the mgmt HTTP port.
- **Running**: accept inbound messages, run turns, persist state.
- **Draining**: new messages 503; in-flight turns finish. Checkpoints ensure nothing is lost if a turn is mid-LLM when the signal arrives.
- **Stopped**: databases closed, pid file removed.

## Background mechanics

Three subsystems shape every turn but are easy to miss in a one-pass read.

### Session extraction (post-turn LLM pass)

When a session closes (`/new`, idle timeout, or branch fork), the `SessionExtractor` (`src/team/src/harness/review/session-extractor.ts`) runs an async LLM call over the transcript and extracts:

- A 1–3 sentence **summary** → stored on the session row, surfaced as `<last_session>` recap in the next session's harness block.
- **Profile patches** (stable preferences) → appended to `profiles.<peerId>`.
- **Note upserts/deletes** (atomic facts with confidence × recency decay) → upserted into `notes` for the peer.
- **New directives** (rules the user explicitly stated) → inserted into `directives`.
- A possible **skill proposal** (kebab-case name + body) → written to `~/.flopsy/skills/proposed/<name>/SKILL.md`. Proposed skills are NOT auto-loaded — review with `/skills review`.
- **Skill lessons** → appended to existing skills' `LESSONS` block.

Trivial sessions (low message count + no tool-call signal) are skipped to keep LLM costs bounded.

### Personality resolution (per turn)

The active voice overlay is resolved on every turn from a four-tier priority chain in `src/team/src/personalities.ts`:

1. **Override** — `cfg.personality` set by a proactive fire (heartbeat/cron/webhook) that wants a specific voice for this fire.
2. **Session-bound** — `sessions.active_personality` set by the user with `/personality <name>`. Survives across turns until `/new` or `/personality reset`.
3. **Default** — `def.defaultPersonality` from the agent's YAML config. Lets fresh sessions start with a voice instead of bare SOUL.md.
4. **None** — plain SOUL.md baseline.

The chosen overlay is rendered as the **final** block of the system prompt (after SOUL.md, AGENTS.md, and `<runtime>`) so recency-bias gives it maximum influence on tone. Body content is HTML-escaped before injection so a malicious `personalities.yaml` can't smuggle fake system instructions. Workers do not currently inherit the active personality — a delegated worker reply will land in a neutral voice (this is on the roadmap to fix).

### Model selection: three coexisting layers

These look redundant at a glance but each handles a different question. Don't collapse them.

| Layer | When it runs | Question it answers | Source |
|---|---|---|---|
| `model:` field | Construction time | Which model is the *primary* for this agent? | `flopsy.json5` per-agent |
| `ModelRouter` tiers | Construction time | Should we route this agent to fast / balanced / powerful tier? | `routing.tiers` in config → `bootstrap.ts` |
| `fallback_models` | Runtime | When the primary fails (429/5xx/network), what do we retry with? | `flopsy.json5` per-agent → `factory.ts` interceptor |

A request goes: ModelRouter picks a tier from the agent's config → resolves to `model:` for the chosen tier → on call failure, walks the `fallback_models` list. Construction-time tier selection ≠ runtime retry — both are needed.

## Cross-reference

- **Want to extend the agent?** → [Agents](./agents.md), [Tools](./tools.md), [Skills](./skills.md)
- **Want to connect an external service?** → [MCP](./mcp.md), [Channels](./channels.md)
- **Want the agent to act on a schedule?** → [Proactive](./proactive.md)
- **Want to understand what persists?** → [Memory](./memory.md)
