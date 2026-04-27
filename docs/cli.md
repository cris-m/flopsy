# CLI reference

The `flopsy` binary is the operator's interface to the gateway. It manages configuration, inspects state, runs the daemon, and drives diagnostics.

Running `flopsy` with no arguments shows a welcome panel with `Tips for getting started` and `Recent activity`. Every subcommand below also supports `--help` for its own options.

## Command matrix

| Command | What it does | Writes to | Requires gateway running? |
|---|---|---|---|
| `flopsy` | Welcome panel + top-level help | — | no |
| `flopsy onboard` | Interactive first-run wizard | `flopsy.json5`, `.env`, credential store | no |
| `flopsy doctor` | 10-point pre-flight health check | — | optional |
| `flopsy status` | Config-based snapshot of every subsystem | — | optional |
| `flopsy auth ...` | Manage service credentials (Google, etc.) | credential store | no |
| `flopsy mcp ...` | MCP server registry in flopsy.json5 | `flopsy.json5` | no |
| `flopsy gateway ...` | Start / stop / restart the daemon (alias: `run`) | pidfile | (controls it) |
| `flopsy mgmt ...` | Live queries against the running gateway | — | **yes** |
| `flopsy team` | Inspect the configured agent team | — | no |
| `flopsy channel ...` | Inspect / enable / edit channels | `flopsy.json5` | no |
| `flopsy schedule ...` | List + create / disable / remove heartbeats & cron jobs | `proactive.db` | **yes for writes** (reads direct) |
| `flopsy cron` | *Legacy* — list config-defined cron jobs from flopsy.json5 | — | no |
| `flopsy heartbeat` | *Legacy* — list config-defined heartbeats from flopsy.json5 | — | no |
| `flopsy webhook` | List inbound webhooks | — | no |
| `flopsy config ...` | Read/write `flopsy.json5` by dotted path | `flopsy.json5` | no |
| `flopsy model ...` | List/switch the LLM model per agent | `flopsy.json5` | no (restart to apply) |
| `flopsy env reload` | Re-read `.env` and restart the gateway if any key changed | — | optional |
| `flopsy memory ...` | Inspect the harness learning store (skills, lessons, facts) | — | no |

## Discovery

```bash
flopsy --help                    # top-level command list (colorized)
flopsy <command> --help          # subcommand details
flopsy --version                 # one-line banner + version
```

Config discovery order: `FLOPSY_CONFIG` env → walk up from cwd → walk up from CLI install location. This means `flopsy` works from any subdirectory of your project.

## Environment flags

| Variable | Effect |
|---|---|
| `FLOPSY_CONFIG` | Absolute path to `flopsy.json5`. Overrides auto-discovery. |
| `FLOPSY_HOME` | Workspace root (default `~/.flopsy`). |
| `FLOPSY_PROFILE` | Namespace for multi-profile setups — resolves to `~/.flopsy-<profile>/`. Must match `[a-zA-Z0-9_-]+`. |
| `FLOPSY_NO_BANNER=1` | Skip the welcome panel even in a TTY. |
| `FLOPSY_NO_CLEAR=1` | Skip the screen clear before the banner. |
| `FLOPSY_MGMT_TOKEN` | Bearer token required by `flopsy mgmt` and `flopsy schedule add/disable/enable/remove`. |
| `MCP_ROOT` | Base dir against which `${MCP_ROOT}` is expanded in flopsy.json5 MCP `args`. Defaults to the repo root. |
| `NO_COLOR=1` | Disable ANSI colour (stdlib convention). |
| `FORCE_COLOR=1` | Force colour even when stdout isn't a TTY. |

## Life-cycle commands

### `flopsy onboard`

Interactive wizard. Step-by-step: pick channels → paste tokens (masked input) → offer auth (Google OAuth device flow) → offer to start the gateway → hint to run `doctor`.

```bash
flopsy onboard
```

Good for first-time setup. Skippable any time with `Ctrl-C`; partial progress is saved.

### `flopsy doctor`

Ten pre-flight checks:

| Check | Asserts |
|---|---|
| `node` | Node ≥ 22 |
| `flopsy.json5` | parses, resolves required keys |
| `main agent` | Exactly one enabled agent with `role: main` |
| `env placeholders` | Every `${VAR}` in config either set or has `:-default` |
| `ollama` | Reachable at configured baseUrl |
| `auth` | Credentials stored for any MCP servers that need them |
| `gateway` | pidfile + port state |
| `mcp` | Each enabled MCP server has its required env + auth |
| `.flopsy/` | writable |
| `.flopsy/harness/` | writable |

Exits 0 when everything is ok; exits 1 (with counted failures) otherwise. `--json` emits structured output for monitoring.

### `flopsy gateway start|stop|restart|status`

Shell wrapper over `npm start` / `npm run stop` / `npm run restart`. `status` reads the pidfile + port to report whether the daemon is alive.

`flopsy run` is the same command (older name; kept as an alias).

### `flopsy mgmt ping|status`

Talks to the running daemon's HTTP management endpoint (`127.0.0.1:18790` by default). Use this when you want **live** data (currently-connected channels, in-flight turns, today's token counts) instead of the config-only view.

```bash
flopsy mgmt ping                 # round-trip sanity check
flopsy mgmt status --json        # JSON dump for dashboards
```

If the gateway isn't running you'll see `unreachable`; fall back to `flopsy status` for the config view.

## Inspection commands

### `flopsy status`

One-screen config snapshot:

```
▎ Gateway         pid / uptime / address
▎ Channels (3/8)  status dots for each adapter
▎ Auth            stored credentials + expiry
▎ MCP             configured servers + enabled count
▎ Team (4/4)      agents with status dots
▎ Memory          embedder + state
▎ Proactive       heartbeats / cron / webhooks count
▎ Webhook         address + state
```

### `flopsy team`, `flopsy channel`, `flopsy cron`, `flopsy heartbeat`, `flopsy webhook`

Per-subsystem detail. Each supports `list` (default) and `show <name>` for a single-item dump. Status dots: `●` = enabled (section-themed colour), `○` = disabled.

## Write commands

### `flopsy config ...`

General-purpose `flopsy.json5` editor by dotted path.

```bash
flopsy config path                           # print resolved config path
flopsy config get gateway.port               # → 18789
flopsy config get agents.0.model             # → ollama:glm-4.6:cloud

# Values are parsed as JSON first, fall back to string.
flopsy config set gateway.port 19000
flopsy config set agents.0.enabled false
flopsy config set channels.telegram.enabled true
flopsy config set mcp.servers.github.command "npx -y @modelcontextprotocol/server-github"

flopsy config unset channels.whatsapp        # remove a key
flopsy config edit                           # open in $EDITOR
flopsy config                                # pretty-print the whole file
```

**Caveat.** Writes re-serialise as plain JSON, so any JSON5 comments in `flopsy.json5` are lost on the first `config set`. Hand-curated sections with comments should be edited with `flopsy config edit` or directly.

### `flopsy model ...`

Convenience wrapper for `agents[].model`:

```bash
flopsy model list                            # or just `flopsy model`
flopsy model use gandalf ollama:glm-4.6:cloud
flopsy model use legolas anthropic:claude-sonnet-4
```

### `flopsy channel ...`

```bash
flopsy channel list                          # all channels with dots
flopsy channel show telegram                 # full config, secrets masked
flopsy channel show telegram --reveal        # show token in plaintext (careful)
flopsy channel enable discord
flopsy channel disable signal
flopsy channel set telegram.dm.policy open   # dotted-path write into a channel
flopsy channel add telegram                  # interactive add (prompts for token)
```

### `flopsy auth ...`

Manages OAuth credentials stored under `~/.flopsy/credentials/` (or `FLOPSY_HOME/credentials/`). Supports Google today; designed to extend to any provider that uses PKCE or device-flow OAuth.

```bash
flopsy auth list                             # which providers have creds
flopsy auth google                           # start PKCE callback flow
flopsy auth refresh google                   # refresh access token
flopsy auth revoke google                    # revoke + remove
flopsy auth status                           # all creds + expiry
```

### `flopsy mcp ...`

MCP server registry in `flopsy.json5`:

```bash
flopsy mcp list
flopsy mcp show [name]                       # JSON dump; all if no name
flopsy mcp set github '{"command":"npx","args":["-y","@modelcontextprotocol/server-github"]}'
flopsy mcp enable github
flopsy mcp disable github
flopsy mcp remove github
flopsy mcp routes                            # which tools go to which agent
```

See [MCP](./mcp.md) for the full routing model.

### `flopsy schedule ...`

Manage proactive schedules — heartbeats, cron jobs, and (soon) webhooks.
Schedules live in `~/.flopsy/state/proactive.db`, **not** `flopsy.json5`.

**Reads work offline** (direct DB access). **Writes require the gateway
to be running** — they go through the mgmt HTTP endpoint so the live
engine hot-registers the change without a restart.

```bash
# READ (direct DB — works even when gateway is stopped)
flopsy schedule list                          # all schedules
flopsy schedule list --kind heartbeat         # filter: heartbeat | cron | webhook
flopsy schedule show <id>                     # full detail of one

# WRITE heartbeats (requires gateway running)
flopsy schedule add heartbeat \
    --name email-triage \
    --interval 30m \
    --prompt "Check my inbox and flag anything urgent."

flopsy schedule add heartbeat \
    --name morning-check \
    --interval 1h \
    --prompt-file ~/my-prompts/morning-briefing.md \
    --delivery-mode conditional

# WRITE cron — three flavours
flopsy schedule add cron \
    --id q1-deadline \
    --at 1735689600000 \
    --message "Q1 reports are due today. Check status."
# `at` is always oneshot — fires once at that epoch ms.

flopsy schedule add cron \
    --id hourly-queue-check \
    --every 3600000 \
    --message "Check the message queue for new items."
# `every` runs every N ms (min 60000).

flopsy schedule add cron \
    --id morning-briefing \
    --cron "0 8 * * 1-5" --tz "Africa/Nairobi" \
    --prompt-file ~/my-prompts/morning-briefing.md \
    --delivery-mode always
# 5-field cron with optional IANA timezone.

# One-shot a recurring schedule (fires once, auto-disabled, survives restart)
flopsy schedule add heartbeat \
    --name startup-ping --interval 1h --oneshot \
    --prompt "Log a startup diagnostics ping."

# Mutate existing schedules
flopsy schedule disable <id>                  # pause firing
flopsy schedule enable <id>                   # resume
flopsy schedule remove <id>                   # delete (alias: rm)
```

**Delivery modes** (`--delivery-mode`):

| Mode | Behaviour |
|---|---|
| `always` (default) | Agent's reply is always delivered |
| `conditional` | Agent returns JSON `{shouldDeliver, message, reason, topics, reportedIds}`; only delivered when `shouldDeliver=true` |
| `silent` | Agent runs for side-effects only; nothing delivered |

**Prompt files** — Flopsy **copies** the file into the workspace; the schedule owns its copy:

| Kind | Workspace copy |
|---|---|
| `heartbeat` | `~/.flopsy/proactive/heartbeats/<id>-<basename>` |
| `cron` | `~/.flopsy/proactive/cron/<id>-<basename>` |

- Pass any path (absolute or relative to cwd) — the file is copied at creation time
- When you `flopsy schedule remove <id>`, the workspace copy is deleted automatically
- 60s in-memory cache on the gateway, so edits to workspace files propagate to the next tick

**Id conventions** — if you omit `--id`:
- Heartbeat gets `runtime-hb-<name>`
- Cron gets `runtime-cron-<timestamp>-<random>`

Write-time operations return the id so you can pipe it:

```bash
id=$(flopsy schedule add heartbeat --name poll --interval 30m \
       --prompt "ping" | awk '/^id/{print $2}')
flopsy schedule disable "$id"
```

**Recursion guard.** If you (or the agent) tries to create a schedule
from *inside* a thread that was itself spawned by the proactive engine,
the call is refused. This matches Hermes's rule — cron-spawned sessions
can't create more cron jobs (prevents runaway loops).

See [proactive.md](./proactive.md) for the full trigger / delivery / dedup model.

### `flopsy env ...`

```bash
flopsy env reload                 # re-read .env, restart gateway if any key changed
flopsy env reload --dry-run       # show which keys would change, don't restart
```

Scans your current `.env`, compares with the running gateway's snapshot of
the same keys, restarts only when something actually changed. Useful after
rotating a Telegram token or an API key without wanting to fully bounce.

### `flopsy memory ...`

Inspect the per-thread learning harness (SQLite-backed, at
`~/.flopsy/harness/state.db`). Current subcommand:

```bash
flopsy memory kpi                         # summary: strategies, lessons, skills, facts
flopsy memory kpi --namespace <userId>    # scope to one user/thread
flopsy memory kpi --json                  # machine-readable
```

See [memory.md](./memory.md) for the schema model.

## Scripting

All commands respect standard shell conventions:

- Exit codes: `0` success, `1` generic error, `1` on `doctor` failures.
- `--json` on `status`, `doctor`, `mgmt status` for machine-readable output.
- Non-TTY output skips the welcome banner and drops ANSI colour automatically (respect `NO_COLOR`).
- `FLOPSY_NO_BANNER=1` / `FLOPSY_NO_CLEAR=1` for CI logs.

Example health-check snippet for a watchdog:

```bash
#!/usr/bin/env bash
if ! flopsy mgmt ping >/dev/null 2>&1; then
  systemctl restart flopsy-gateway
fi
```
