# Tools

Tools are the verbs an agent can invoke during a turn. FlopsyBot ships a small set of first-party built-in tools plus whatever you wire up via [MCP servers](./mcp.md). Each agent has an explicit **toolset allow-list**; agents only see tools from their allow-list plus routed MCP servers.

## Built-in tool catalog

All tools live in `src/team/src/tools/`. Each is one file exporting a schema + an execute function.

### Always available to main (gandalf)

| Tool | Purpose |
|---|---|
| `send_message` | Send text/media to a channel peer (with optional buttons, polls inline, quote-reply) |
| `send_poll` | Post a poll on channels that support it; fallback numbered prompt elsewhere |
| `ask_user` | Channel-aware interactive question — buttons on rich channels, `1./2.` text on plain |
| `react` | Add an emoji reaction to the user's last message (silent on channels without reactions) |
| `delegate_task` | Hand work to a worker; block until reply. Depth-3 nesting, loop detection |
| `spawn_background_task` | Fire-and-forget worker task; result arrives later as `<task-notification>` |
| `search_conversation_history` | FTS5 query over `learning.db` messages |
| `connect_service` | Start OAuth device-flow for a new service (Google, Spotify, etc.) |
| `manage_schedule` | Create/edit cron/heartbeat/webhook schedules in chat |
| `skill_manage` | Create / append-lessons / patch / bump-version / archive / pin skills |

### Worker control tools

Workers (legolas/gimli/saruman/aragorn) get a smaller control surface:

| Tool | Purpose |
|---|---|
| `delegate_task` | Workers can chain further (max depth 3, loops blocked) |
| `spawn_background_task` | For long-running async work |
| `notify_teammate` | Push a short note to another worker's thread |
| `skill_manage` | Workers can also capture procedures they discovered — writes to `skills-proposed/` for human review |

Workers do NOT have `send_message`, `send_poll`, `ask_user`, `react`, or `connect_service` — workers reply to their parent, not to the user.

### Proactive-mode filter

When the main agent fires under a cron/heartbeat (`proactiveMode: true`), these are stripped so the agent must return prose / `__respond__` instead of side-effecting:

```
delegate_task, spawn_background_task, ask_user, react,
send_poll, manage_schedule, send_message
```

`skill_manage` is **not** in this stripped list — agents can still create skills mid-fire.

## Tool anatomy

```mermaid
flowchart LR
  LLM["LLM decides to call tool"] --> SCHEMA["Validate args<br/>(Zod)"]
  SCHEMA -->|ok| EXEC["Execute"]
  SCHEMA -->|fail| ERR["Tool error → LLM"]
  EXEC --> EFFECT["Side effect<br/>(channel send, DB write, …)"]
  EFFECT --> RESULT["Typed result"]
  RESULT --> LLM
```

## Tool anatomy

```mermaid
flowchart LR
  LLM["LLM decides to call tool"] --> SCHEMA["Validate args<br/>(Zod)"]
  SCHEMA -->|ok| EXEC["Execute"]
  SCHEMA -->|fail| ERR["Tool error → LLM"]
  EXEC --> EFFECT["Side effect<br/>(channel send, DB write, …)"]
  EFFECT --> RESULT["Typed result"]
  RESULT --> LLM
```

Under the hood each tool has:

- **`name`** — what the LLM calls (`send_message`, `delegate_task`).
- **`description`** — one-sentence doc the LLM reads.
- **`schema`** — Zod schema for args; rejection is reported to the LLM as a soft error, not an exception.
- **`execute`** — async function, runs in the turn's context (access to channel registry, agent manager, memory store).
- **`allowedCallers`** — optional restriction to specific agents or to Anthropic's `code_execution_20250825` server-side runner.

## Toolsets

Agents don't enumerate every tool individually — they reference named bundles called **toolsets**. Toolsets live in code; each is a named list of tool instances. Common ones:

| Toolset | Tools | Typical audience |
|---|---|---|
| `core` | `send_message`, `react`, `search_past_conversations` | Every agent |
| `team` | `delegate_task`, `spawn_background_task`, `ask_user` | Main only |
| `memory` | memory read/write, user-fact tagging | Any agent that should personalize |
| `polling` | `send_poll` | Main on rich channels |

Configure in `flopsy.json5`:

```json5
{
  name: "gandalf",
  toolsets: ["core", "team", "memory", "polling"],
}
```

## Approvals

Tools can be gated behind human approval. When an agent tries to call a tool in the approval list, the gateway emits an `ask_user` turn on the active channel and pauses the conversation until the user clicks approve/deny.

```json5
{
  name: "gandalf",
  approvals: {
    tools: ["send_poll", "connect_service"],
    actions: ["delete_thread", "revoke_auth"]
  }
}
```

Approval buttons render natively on Telegram/Discord/Slack/Line and fall back to `1. Approve / 2. Deny` text on SMS-style channels (iMessage, Signal, WhatsApp).

## MCP tools

MCP servers contribute additional tools at runtime. Tool names are namespaced as `<server>__<tool>` (e.g. `github__get_issue`, `filesystem__read_file`). Agents only see MCP tools from servers in their `mcpServers` allow-list. See [MCP](./mcp.md) for details.

## Programmatic tool calling

For complex multi-step workflows, FlopsyBot supports **programmatic tool calling**: instead of the LLM making N separate tool calls, it writes a small Python/JS script that invokes tools as normal functions through a local HTTP bridge. Saves turn count, works with any LLM provider (not only Anthropic).

Enable per-agent:

```json5
{
  name: "saruman",
  programmaticToolCalling: true
}
```

The bridge is a localhost HTTP server spawned by the sandbox module; the injected runtime stubs forward calls to the agent's tool set. Code runs in a sandbox (local / Docker / Kubernetes backend).

## Tool quirks (failure surfacing)

Every tool call goes through `HarnessInterceptor.afterToolCall` (`src/team/src/harness/hooks/harness-interceptor.ts`):

- **On error**: writes a row into `tool_failures` keyed `(peerId, toolName, errorPattern)`. Repeated failures bump `count` instead of inserting a duplicate.
- **On success**: deletes any rows for that `(peerId, toolName)` — failures auto-clear once the tool works again.

At the start of every agent turn, the harness injects the top 5 recent failures (last 7d) into the prompt as a `<tool_quirks>` block:

```
<tool_quirks description="Tools that have been failing recently for this user...">
  spawn_background_task: "fetch failed (ollama/kimi-k2.6:cloud): NetworkError" (×3, last 72h ago)
</tool_quirks>
```

The agent reads this and avoids retrying the same broken path.

## Self-state (skill catalog telemetry)

The harness also injects a `<self_state>` block once per session showing the agent its own skill catalog metrics — total skills, agent-created count, by_state breakdown, most-used skill, and warnings when no agent-created skills exist. Source: `.skill-state.json` (written by `SkillUsageStore`).

## Observability

Every tool invocation logs:

- `tool_name`, agent, `turn_id`, `thread_id`
- arg keys (values redacted to avoid leaking secrets)
- duration, success / failure
- any downstream events (channel send → message id)

`flopsy mgmt status` aggregates today's tool calls per agent.

## Related

- [Agents](./agents.md) — who gets which toolsets
- [Skills](./skills.md) — skills tell agents which tools to reach for
- [MCP](./mcp.md) — adding external tools via MCP servers
