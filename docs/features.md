# FlopsyBot — Feature overview

FlopsyBot is a **personal AI assistant that runs locally**, talks to you on any messaging channel you configure, and initiates conversation when it has something to say. It's a team of specialist agents behind a single gateway, backed by SQLite for durable state, and controllable from both chat and a `flopsy` CLI.

This document is an at-a-glance tour of everything the system does. Each section links to the deep-dive doc in this folder when one exists.

---

## 1. Multi-channel gateway

One bot, many front-ends. Each channel is an independent plugin — enable the ones you use, leave the rest off.

| Channel | Inbound | Outbound | Rich UI |
|---|---|---|---|
| Telegram | ✅ | ✅ | buttons, polls, reactions, media |
| Discord | ✅ | ✅ | buttons, select menus, reactions |
| WhatsApp | ✅ | ✅ | plain text (no buttons) |
| Signal | ✅ | ✅ | plain text only |
| iMessage | ✅ | ✅ | Tapbacks via channel-native presence |
| Line | ✅ | ✅ | stickers, plain |
| Slack | ✅ | ✅ | buttons, threads |
| Google Chat | ✅ | ✅ | plain text |
| Inbound webhooks | ✅ | — | external services push events in |

Channel configuration is per-platform in `flopsy.json5`. DM policy (`open` / `allowFrom`-list) and group activation controls keep the bot scoped. See [channels.md](./channels.md).

### Channel-aware UI
Tools declare capability requirements; the agent sees a runtime `capabilities: buttons, polls, typing` block in its prompt and picks a renderable tool for the active channel. `send_message`, `send_poll`, `react`, `ask_user` — all fall back gracefully when a channel lacks native support.

---

## 2. Team of specialist agents

A small fellowship behind one leader.

| Agent | Role | Owns |
|---|---|---|
| **gandalf** | `main` | Orchestration, user-facing, delegation, schedule management |
| **legolas** | `worker` (research) | Web research + Google Workspace (gmail, calendar, drive, youtube) |
| **saruman** | `worker` (deep-research) | Long-running multi-round research via `createDeepResearcher` |
| **gimli** | `worker` (analysis) | Critic + Notion/Todoist/Obsidian/Apple Notes/Apple Reminders |
| **aragorn** | `worker` (security) | OSINT, VirusTotal, Shodan, X/Twitter lookup |
| **sam** | `worker` (media/home) | Spotify, smart home (Home Assistant) |

Roster is defined in `flopsy.json5 → agents[]`. Each agent has its own model, fallback chain, toolsets, MCP kit, and optional sandbox. Modify from CLI:

```bash
flopsy team list                     # roster + live activity
flopsy team show saruman             # full detail
flopsy team enable|disable aragorn
flopsy team set legolas model anthropic:claude-sonnet-4
flopsy team set saruman sandbox.enabled true
```

See [agents.md](./agents.md).

### Delegation
Gandalf doesn't do everything himself — he routes by capability via `delegate_task("legolas", "...")` (blocking, get the result back) or `spawn_background_task("saruman", "...")` (fire-and-forget, results arrive as `<task-notification>` in a later turn). One-layer-deep by design: workers can't delegate further.

### Per-thread task registry
Every delegation / background task gets a typed id (`t1`, `t2`, `j1`, `s1`) stored in the thread's `TaskRegistry`. Surfaced via `/status`, `/tasks`, and `flopsy tasks` (cross-thread view).

---

## 3. Proactive engine

The bot initiates conversation. Three trigger types:

### Heartbeats — fixed interval
```bash
flopsy heartbeat add --name email-triage --interval 30m \
  --prompt "Check my inbox and flag urgent items." \
  --delivery-mode conditional
```

### Cron jobs — calendar schedule
Three variants:
```bash
# One-shot at a moment
flopsy cron add --id call-mom --at $(node -e "console.log(Date.now()+120000)") \
  --message "Call mom"

# Fixed interval (≥60s)
flopsy cron add --id hourly-check --every 3600000 --message "Queue check"

# Cron expression with timezone
flopsy cron add --id morning-briefing --cron "0 8 * * 1-5" --tz "Africa/Nairobi" \
  --prompt-file morning.md
```

### Inbound webhooks — external services push in
```bash
flopsy webhook add --name github-release \
  --path /webhook/github --target-channel telegram \
  --secret "$GITHUB_WEBHOOK_SECRET"
```

Agent tool `manage_schedule` offers the same for in-chat creation ("remind me in 2h to call mom" → agent creates a one-shot cron).

### Persistence
All three live in `~/.flopsy/state/proactive.db` (`proactive_runtime_schedules` table), keyed by `(id, kind)`. Schedules survive restarts. One-shots mark themselves completed in `proactive.json completedOneshots[]` so the DB row is removed AND a restart never re-fires them.

### Missed-fire handling (startup catchup)
Openclaw-style. On gateway start the engine scans:
- Heartbeats overdue by > 1.5× interval
- `every` cron overdue by > 1.5× period
- `cron` expressions with `previousRun() > lastRunAt`
- `at` cron in the past → fire within 2-min grace, else mark complete

Up to 5 catchup fires per restart, staggered 5s apart (cap prevents post-outage flood). Excess candidates are deferred to their next regular fire.

### Delivery gates (three, all explicit)
| Gate | Source | When |
|---|---|---|
| **DND / quiet hours** | User explicit (`/dnd`, `flopsy dnd`) | `shouldSuppress()` → suppressed |
| **Conditional mode** | Agent judgement | `deliveryMode: conditional` + `shouldDeliver: false` → suppressed |
| **Anti-repetition** | Auto content-dedup | Embedding similarity ≥0.88 / topic match / reported-IDs match → suppressed |

If none fire → delivered straight to channel.

### DND — pause proactive at will
```bash
# Chat
/dnd 2h
/dnd 30m focus
/dnd quiet 22:00
/dnd off

# CLI
flopsy dnd
flopsy dnd on --for 2h --reason meeting
flopsy dnd quiet --until 22:00
flopsy dnd off
```

Both surfaces hit the same `PresenceManager` via mgmt HTTP. Takes effect instantly, no restart.

### Anti-repetition (three layers)
1. **Embedding similarity** — auto. Every delivered message is embedded (via `memory.embedder`); next delivery is cosine-compared against the last 48h and suppressed if ≥0.88.
2. **Topic tags** — agent-aware. The prompt is prepended with `<anti_repetition>` block listing recent topics + cooldown ("DO NOT repeat these — pick a new angle or suppress"). Delivered topics: 3-day cooldown. Suppressed ones: 12h.
3. **Stable IDs** — agent-emitted. Agent writes `REPORTED: emails=[msg-a, msg-b]` in its reply; parser stores them per type. Future fires see "Already reported IDs: ..." and skip duplicates. News/briefing/digest jobs auto-extract URLs.

See [proactive.md](./proactive.md).

---

## 4. Sandbox + programmatic tool calling

Flopsygraph's sandbox wired into each agent on demand (`sandbox` block in `flopsy.json5 → agents[]`).

One unified tool per opt-in agent:
- **`execute_code`** — run Python/JS/TS/bash in isolation. Backends: `local` (dev), `docker` (prod), `kubernetes` (enterprise).
  - `run_in_background: true` — long-running daemons (`npm run dev`, watchers); returns a task id. Read with `get_task_output`, kill with `stop_task`, list with `list_tasks`.
  - `use_tools: true` — code can call *every other agent tool as a function*. HTTP bridge (per-session auth token) exposes `weather(city="Tokyo")`, `web_search(query="...")`, etc. to the sandbox. Only `print()` output enters LLM context — massive token + latency savings on multi-tool queries.

Config:
```json5
sandbox: {
    enabled: true,
    backend: "local",
    language: "python",
    timeout: 30000,
    programmaticToolCalling: true
}
```

See [sandbox.md](../flopsygraph/docs/sandbox.md).

---

## 5. MCP integration

FlopsyBot connects to any Model Context Protocol server — Gmail, Google Calendar, Drive, YouTube, Notion, Obsidian, Todoist, Apple Notes, Apple Reminders, Spotify, Home Assistant, VirusTotal, Shodan, Twitter, Browser. ~15 default servers.

Each MCP server is routed to specific workers via `assignTo` in `flopsy.json5 → mcp.servers.<name>`. Tools become dynamic catalog entries — the agent uses `__search_tools__({"query": "email"})` to discover them and `__load_tool__({"name": "..."})` to activate.

```bash
flopsy mcp list                    # all configured servers + enabled state
flopsy mcp show github             # one server's full config
flopsy mcp enable|disable github
flopsy mcp routes                  # "which MCP goes to which agent?"
```

OAuth lifecycle handled by `flopsy auth`:
```bash
flopsy auth google                 # PKCE device flow
flopsy auth refresh google
flopsy auth status
```

See [mcp.md](./mcp.md).

---

## 6. DCL — Dynamic Catalog Loading

Static tools (weather, time, web_search, calculator, send_message, …) are pre-bound to each agent's LLM tool-call schema.

Dynamic tools (the ~30 MCP entries) aren't — they live in a catalog appended to the prompt ("`notion__search`: Search a Notion workspace [available]"). The agent activates them on demand via the `__search_tools__` / `__load_tool__` meta-tools, which stay on the bound list. Keeps the tool payload small on every turn while giving access to many tools.

---

## 7. Skills — 79 reusable playbooks

`src/team/templates/skills/` ships markdown playbooks agents load when relevant. Each has YAML frontmatter + a "When to Use" trigger section. Examples:

| Category | Skills |
|---|---|
| Communication | slack, telegram, discord, whatsapp, signal, line, imessage, google-chat, email-drafting |
| Research | research, web-research, arxiv-search, osint, source-assessment, geopolitical-analysis, media-comparison, historical-parallel |
| Reasoning | argument-mapping, critical-analysis-chain, decision-framework, mental-models, multi-perspective, self-critique, contradiction-tracker |
| Productivity | planning, plan-my-day, writing-plans, executing-plans, daily-rhythm, habit-tracker, financial-tracker, interview-coach |
| Engineering | coding, code-review, debugging, verification, project-scaffolding, maintenance, pattern-library |
| MCP/integration | google-workspace, notion, obsidian, github, home-assistant, spotify, twitter, shodan, virustotal |
| Meta | skill-creator, skill-security, memory, tool-use, proactive, scheduler, heartbeat |

Agents load skills via flopsygraph's `skills` interceptor — trigger phrases match, markdown prepended to system prompt for that turn. Background reviewer can promote "reusable procedures" observed in the learning harness into new SKILL.md files.

See [skills.md](./skills.md).

---

## 8. Memory + learning harness

SQLite-backed per-thread learning store at `~/.flopsy/harness/state.db`.

- **Facts / user profile** — persistent across sessions. Agent saves via `manage_memory` tool, searches via semantic `search_memory` (cosine with `memory.embedder`).
- **Session search** — FTS5 index of all past messages; `search_past_conversations("when did we discuss rag?")` recalls prior turns.
- **Learning snapshots** — interceptor captures "I learned X" / "user corrected Y" every N turns; background reviewer distils patterns into skills.
- **Token accounting** — every LLM call recorded with provider/model/input/output/calls; surfaced in `/status`.

Memory is namespaced: `memories:gandalf` shared across topics, `memories:legolas` etc. per-worker to prevent cross-pollination. See [memory.md](./memory.md).

---

## 9. Slash commands — in-chat control

Fast, no-LLM handlers run before any agent turn. Available in every channel:

| Command | What it does |
|---|---|
| `/status` (`/s`) | Gateway + team + proactive snapshot for this thread |
| `/team` (`/t`, `/roster`) | Team roster with per-worker live state + sandbox/MCP metadata |
| `/tasks` (`/task`, `/work`) | Active + recent background tasks in this thread |
| `/doctor` (`/health`, `/check`) | Problem-focused health verdict with remediation hints |
| `/dnd` (`/quiet`) | Toggle DND — see §3 |
| `/audit` | Config sanity + credential expiry audit |
| `/help` (`/?`) | List every registered slash command |

Auto-discoverable — new slash handlers land in `/help` automatically on the next restart.

---

## 10. CLI — full operator surface

`npm run flopsy <...>` or install globally.

### Discovery
```bash
flopsy                        # welcome panel + top-level help
flopsy --version              # version + banner
flopsy <command> --help       # subcommand details
```

### Life-cycle
```bash
flopsy onboard                # first-run wizard (channels + auth + .env)
flopsy doctor                 # 10-point pre-flight check (exits 1 on failures)
flopsy status                 # compact one-screen snapshot
flopsy status --verbose       # expanded per-section detail
flopsy status --json          # machine-readable for monitoring
flopsy gateway start|stop|restart|status
flopsy mgmt ping|status       # live queries against the running daemon
```

### Inspection
```bash
flopsy team [list|show|enable|disable|set]
flopsy channel [list|show|enable|disable|set|add]
flopsy heartbeat [list|show|add|disable|enable|remove]
flopsy cron      [list|show|add|disable|enable|remove]
flopsy webhook   [list|show|add|disable|enable|remove]
flopsy tasks     [list|show]      # all threads
flopsy memory kpi                 # harness learning store summary
```

### Config / runtime
```bash
flopsy config get|set|unset <path>       # dotted-path edit
flopsy config edit                        # $EDITOR
flopsy model list|use <agent> <model>     # swap per-agent model
flopsy env reload                         # re-read .env, restart if changed
flopsy auth google|spotify|twitter        # OAuth flow
flopsy dnd [on|off|quiet]                 # pause proactive
flopsy mcp list|show|enable|disable|routes
```

See [cli.md](./cli.md).

---

## 11. Observability

Every subsystem reports into the same snapshot:

- **Gateway**: pid, uptime, port, active turns
- **Channels**: connected / connecting / disconnected / error per-channel
- **Team**: idle / working / disabled per agent, current task
- **Proactive**: heartbeat + cron + webhook counts, delivered/suppressed/error breakdown (via `JobState`)
- **Integrations**: auth expiry, MCP server status, memory embedder
- **Paths**: config file, workspace root

Surfaces:
- `flopsy status` (compact / verbose / json)
- `/status` in any channel (same data, markdown-formatted)
- `flopsy mgmt status --json` (for Prometheus / dashboards)

Health monitor runs every 5 minutes: detects stale events, channel connection drops, excess restart rate; can auto-restart channels.

---

## 12. Configuration

Single `flopsy.json5` file — comments allowed, comma-tolerant. Discovery: `FLOPSY_CONFIG` env → walk up from cwd → walk up from CLI install. Workspace at `~/.flopsy/` (override via `FLOPSY_HOME`, profile via `FLOPSY_PROFILE`).

### Top-level sections
```json5
{
    gateway:   { host, port, mgmt, rateLimit, deduplication, reload },
    channels:  { telegram, discord, whatsapp, ... },
    webhook:   { enabled, host, port, secret, allowedIps },
    proactive: { enabled, delivery, followActiveChannel, heartbeats, scheduler, healthMonitor },
    agents:    [ { name, type, role, domain, model, toolsets, mcpServers, sandbox, approvals } ],
    mcp:       { enabled, servers: { <name>: { command, args, env, assignTo } } },
    memory:    { enabled, embedder: { provider, model } },
    logging:   { level, files, scrub }
}
```

### Hot-reload vs restart
Most channel tokens and MCP env changes hot-reload. Model + agent structural changes require `flopsy gateway restart`. The config reloader logs which rule each edit hit.

---

## 13. Security

Defense-in-depth patterns borrowed from Hermes:
- **User authorization** — allowlists per channel, DM policy `open` / `allowFrom` / `blockedFrom`
- **Approval gate** — `agents[].approvals.tools` marks sensitive tools; gateway pauses turn via `GraphInterrupt` for user approval
- **Container isolation** — Docker/K8s sandbox for untrusted code; `validateCode()` regex scan on both entry paths
- **MCP env filter** — environment variables stripped to an allowlist before spawning MCP subprocesses
- **Credential store** — `~/.flopsy/credentials/*.json` chmod 600; refresh tokens separate file
- **Cross-thread isolation** — per-thread `memories:<agent>` namespace; cron jobs get their own scoped sessions
- **Path traversal prevention** — VirtualFs validates all sandbox file access; CLI paths anchored to `FLOPSY_HOME`
- **Bearer token** — optional `FLOPSY_MGMT_TOKEN` gates mgmt HTTP endpoints

---

## 14. Workspace layout

```
~/.flopsy/                              # FLOPSY_HOME
├── flopsy.json5                        # (optional — can live next to project)
├── SOUL.md                             # agent voice / persona
├── AGENTS.md                           # operations manual
├── skills/                             # SKILL.md files (agent-facing)
├── state/
│   ├── proactive.db                    # schedules + delivery history + dedup
│   ├── proactive.json                  # presence, queue, oneshot markers
│   └── retry-queue.json                # transport-failure retries
├── harness/
│   ├── state.db                        # learning store (facts, memories, tokens)
│   ├── memory.db                       # semantic memory (embeddings)
│   └── checkpoints.db                  # graph state per thread
├── proactive/
│   ├── heartbeats/                     # prompt files copied-in per schedule
│   └── cron/
├── credentials/                        # OAuth tokens (chmod 600)
├── auth/                               # per-provider pairing material
├── logs/
│   └── gateway.out.log                 # daemon stdout/stderr
└── gateway.pid                         # running daemon marker
```

---

## 15. Development loop

```bash
npm start                               # tsx src/main.ts (dev) — reads src directly
npm run dev                             # watch mode
npm run restart                         # kill + start
npm run build                           # tsc --build src/app (prod bundle)
npm test                                # team package tests

# Per-package typecheck
npx tsc -p src/shared/tsconfig.json
npx tsc -p src/gateway/tsconfig.json
npx tsc --noEmit -p src/team/tsconfig.json
npx tsc --noEmit -p src/cli/tsconfig.json
```

Monorepo layout: `src/shared`, `src/gateway`, `src/team`, `src/cli`, `src/app` (entry point), `flopsygraph/` (vendored framework). TypeScript ESM with `moduleResolution: "bundler"`.

---

## Quick links

| Doc | Topic |
|---|---|
| [architecture.md](./architecture.md) | System design and package boundaries |
| [gateway.md](./gateway.md) | Channel router, webhook receiver, mgmt server |
| [agents.md](./agents.md) | Team roster, roles, delegation |
| [channels.md](./channels.md) | Per-channel capabilities + DM policy |
| [proactive.md](./proactive.md) | Heartbeats, cron, webhooks, delivery, dedup |
| [tools.md](./tools.md) | Static + dynamic tool catalog |
| [memory.md](./memory.md) | Learning harness + semantic memory |
| [mcp.md](./mcp.md) | MCP server config + routing |
| [skills.md](./skills.md) | Skill authoring + trigger patterns |
| [cli.md](./cli.md) | Full `flopsy` command reference |
| [flopsygraph/docs/sandbox.md](../flopsygraph/docs/sandbox.md) | Sandbox + programmatic tool calling |

---

## At-a-glance — what makes FlopsyBot different from a plain LLM bot

1. **Initiates conversation** — proactive heartbeats, cron, inbound webhooks
2. **Remembers across sessions** — per-thread harness, semantic search, FTS5 recall
3. **Team of specialists** — one leader delegates to purpose-built workers
4. **Multi-channel** — same bot on Telegram + Discord + Signal + …
5. **Code execution** — flopsygraph sandbox with HTTP tool bridge (programmatic tool calling)
6. **MCP-native** — 15+ servers for real apps (Gmail, Notion, Home Assistant, …)
7. **Self-managing** — missed-fire catchup, anti-repetition, health monitor, retry queue
8. **Operator-friendly** — full CLI + slash commands + hot-reload + DND
9. **Private + local** — runs on your machine, your keys, your data
