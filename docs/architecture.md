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

## Cross-reference

- **Want to extend the agent?** → [Agents](./agents.md), [Tools](./tools.md), [Skills](./skills.md)
- **Want to connect an external service?** → [MCP](./mcp.md), [Channels](./channels.md)
- **Want the agent to act on a schedule?** → [Proactive](./proactive.md)
- **Want to understand what persists?** → [Memory](./memory.md)
