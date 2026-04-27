# FlopsyBot

A personal AI gateway that lives on your machine. One config file (`flopsy.json5`), one workspace (`~/.flopsy/`), and a small team of specialist agents reachable from every chat app you use — Telegram, Discord, WhatsApp, Slack, Google Chat, Signal, Line, iMessage.

## What it does

- **Multi-channel**: send it a message on any connected platform, get a coherent reply. Thread context is preserved per-channel.
- **Multi-agent team**: a "main" agent handles the conversation and delegates to specialist workers (security, research, media, etc.) defined in your config.
- **Proactive**: heartbeats (every 30 min), cron jobs (Mon–Fri 8 am), and webhook triggers (GitHub, Stripe, CI) can initiate messages to you without being asked.
- **Tool-using**: MCP servers plug in calendar, drive, spotify, obsidian, terminal, and anything else that speaks MCP.
- **Learns over time**: a SQLite-backed harness records what worked, what failed, and which skills the agent has written for itself — reused across future turns.
- **Local-first**: models run on Ollama by default. Cloud models (Anthropic, OpenAI, NVIDIA, etc.) are opt-in per-agent.

## Prerequisites

- **Node.js** ≥ 22
- **Ollama** running locally ([install](https://ollama.com)) — needed for the embedder used by semantic memory and proactive dedup
- **Platform**: macOS or Linux. iMessage channel requires macOS.
- Optional per channel: Telegram bot token, Discord app token, Signal CLI, etc. Each is configured in `flopsy.json5`.

## Quickstart

```bash
# 1. Clone + install
git clone https://github.com/<you>/FlopsyBot.git
cd FlopsyBot
npm install

# 2. Pull a tool-capable local model (example)
ollama pull glm-4.7-flash
ollama pull nomic-embed-text:v1.5   # for semantic memory + proactive dedup

# 3. Verify environment
npm run flopsy doctor

# 4. Bootstrap your workspace (~/.flopsy/)
npm run flopsy onboard

# 5. Edit flopsy.json5 — enable one channel and add your credentials

# 6. Start the gateway
npm start
```

The gateway runs on `127.0.0.1:18789` by default. Messages land on whichever channels you enabled and route through the agent team.

## CLI overview

The `flopsy` CLI is invoked via `npm run flopsy <command>`:

```
npm run flopsy doctor          # check Node, Ollama, config, credentials
npm run flopsy status          # live status of gateway + channels + workers
npm run flopsy onboard         # bootstrap ~/.flopsy/ with defaults
npm run flopsy auth google     # OAuth device flow for Google (Calendar, Drive, Gmail)
npm run flopsy auth spotify    # Spotify OAuth
npm run flopsy auth twitter    # cookie-based X/Twitter auth via bird CLI
npm run flopsy memory kpi      # summary of the persistent learning store
npm run flopsy env reload      # re-read .env and restart gateway
npm run flopsy config get      # dump active config
npm run flopsy gateway start   # alias for npm start
npm run flopsy gateway stop
```

See `docs/cli.md` for the full command reference.

## Project layout

Monorepo with npm workspaces — each `src/*` directory is its own package.

```
src/
├── app/           — entry point (@flopsy/app → runs the gateway)
├── shared/        — config schema, logger, workspace paths, shared types
├── gateway/       — channel adapters, message router, webhook server, proactive engine
├── team/          — TeamHandler, learning harness, skill/lesson/fact stores, MCP glue
├── cli/           — the flopsy CLI (doctor/status/auth/onboard/...)
└── mcp-servers/   — bundled MCP servers (obsidian, terminal, twitter, etc.)

flopsygraph/       — graph-based agent runtime (separate library, its own repo)
flopsy-server/     — optional HTTP/web UI for the gateway (separate project)
```

## Environment variables

| Var | Purpose | Default |
|-----|---------|---------|
| `FLOPSY_HOME` | Workspace root — where state, skills, credentials, memory live | `~/.flopsy` |
| `FLOPSY_PROFILE` | Namespace for multiple configs (`dev`/`prod`) → `~/.flopsy-<profile>` | — |
| `FLOPSY_CONFIG` | Path to `flopsy.json5` — overrides the default lookup | `$FLOPSY_HOME/flopsy.json5` |
| `FLOPSY_MGMT_TOKEN` | Bearer token for the management HTTP endpoint | — (localhost-only when unset) |
| `MCP_ROOT` | Base directory the MCP `args` templates expand `${MCP_ROOT}` against | repo root |

Per-channel credentials (bot tokens, OAuth secrets) are resolved from `flopsy.json5` — not env vars.

## Documentation

- `docs/architecture.md` — system overview and module graph
- `docs/gateway.md` — message flow, channels, webhook router
- `docs/agents.md` — how the team is defined and delegated to
- `docs/tools.md` — toolsets, MCP servers, per-agent tool assignment
- `docs/proactive.md` — heartbeats, cron, webhook triggers
- `docs/memory.md` — semantic memory + the learning harness
- `docs/cli.md` — every CLI subcommand
- `docs/channels.md` — per-platform setup notes

## Status

Early. Expect rough edges and breaking changes. The code is written to be readable — start in `src/app/src/main.ts` and follow the imports.

## License

MIT
