# Hooks

A **hook** is an operator-authored handler that fires on a gateway lifecycle event. Hooks are loaded from `.flopsy/content/hooks/<name>/HOOK.yaml` at gateway start and run deterministically — no LLM in the loop, no agent decision.

## When to use a hook (vs a tool, vs a skill)

| Use case | Right primitive |
|---|---|
| "When X happens, push a JSON line to a file" | **Hook** |
| "When X happens, post to a Slack webhook" | **Hook** (shell handler) |
| "Whenever the user asks about Y, suggest doing Z" | Skill |
| "Let the agent do Z when it decides to" | Tool |
| "Run script every 2 hours" | Cron (proactive) |

Hooks are for *side effects* on real events. They cost nothing (no LLM call), fire reliably (synchronous within bounded concurrency), and you write them in YAML + a shell script or a TypeScript handler.

## Anatomy

A hook is a directory:

```
.flopsy/content/hooks/
├── boot/
│   ├── HOOK.yaml             # config
│   └── handler.ts            # TypeScript handler (exports `handle`)
└── shell-boot-log/
    ├── HOOK.yaml
    └── handler.sh            # shell script (executable)
```

`HOOK.yaml` schema (`src/gateway/src/hooks/types.ts`):

```yaml
name: boot                    # optional — defaults to dir name
description: |                # optional — free-form
  What this hook does, surfaced in `flopsy hooks list`.
enabled: true                 # default true
events:                       # required — array of event names
  - gateway.startup
  - gateway.shutdown
handler: handler.ts           # OR
script: handler.sh            # one of the two
```

### TypeScript handler

```ts
// handler.ts
export async function handle(eventType: string, context: Record<string, unknown>) {
    console.log(`[boot] ${eventType} at ${context.firedAt}`);
    // …whatever you want. Errors are caught and logged.
}
```

The handler module is dynamically imported once at gateway start. Top-level imports are fine; the runtime is plain Node.

### Shell handler

```sh
#!/usr/bin/env bash
# handler.sh — context arrives on stdin as JSON.
read -r ctx
echo "$ctx" >> "$FLOPSY_HOME/logs/boot.jsonl"
```

Shell handlers must be `chmod +x`. They get 30 s wall-clock, no stdin/stdout coupling beyond the JSON payload, and `FLOPSY_HOME` in the environment.

## Event taxonomy

Every event carries `eventType` (the literal name) and `firedAt` (ms epoch). Beyond that, the payload is event-specific.

| Event | Fired by | Context fields |
|---|---|---|
| `gateway.startup` | `src/gateway/src/gateway.ts` after all channels connect | `version`, `enabledChannels[]`, `pid`, `uptimeMs: 0` |
| `gateway.shutdown` | `gateway.ts` on graceful drain | `uptimeMs`, `reason` |
| `proactive.fire.delivered` | `src/gateway/src/proactive/pipeline/executor.ts` | `jobId`, `jobName`, `durationMs`, `category`, `confidence`, `message` (truncated), `deliveryMode` |
| `proactive.fire.suppressed` | executor — DND, conditional false, dedup | + `silenceReason` |
| `proactive.fire.error` | executor on agent failure | + `error` |
| `command.<name>` | `src/gateway/src/commands/dispatcher.ts` after every slash command | `command`, `channelName`, `peerId`, `args`, `success` |

New events are added by calling `emitHook(eventName, context)` at the relevant callsite. Naming convention: `subsystem.subject.verb` (e.g. `proactive.fire.delivered`).

## Loading + execution model

`src/gateway/src/hooks/loader.ts` walks `.flopsy/content/hooks/`, validates each `HOOK.yaml`, loads the handler (TS via dynamic import, shell by path), and registers it in the in-memory `HookRegistry`.

`emitHook(eventType, context)` consults the registry for matching subscribers and runs them with **bounded concurrency (default 8)**. Wildcards are supported in `events:` — `command.*` subscribes to every slash command, `proactive.fire.*` to every proactive outcome.

If a handler throws (TS) or exits non-zero (shell), the failure is logged but the gateway continues — hook failures **never** propagate up to the firing site.

## CLI

```bash
flopsy hooks list                # all configured hooks + enabled state
flopsy hooks list --json
```

The current CLI is read-only; edit `.flopsy/content/hooks/<name>/HOOK.yaml` directly to disable, or `mv <hook-dir>` somewhere outside to remove. Reload happens at the next `flopsy gateway restart`.

## Worked example: ping Telegram on proactive errors

`.flopsy/content/hooks/proactive-error-alert/HOOK.yaml`:

```yaml
name: proactive-error-alert
description: Forward proactive fire errors to a private Telegram channel
enabled: true
events:
  - proactive.fire.error
script: handler.sh
```

`.flopsy/content/hooks/proactive-error-alert/handler.sh`:

```sh
#!/usr/bin/env bash
read -r ctx
err=$(echo "$ctx" | jq -r '.error // .reason // "unknown"')
job=$(echo "$ctx" | jq -r '.jobName')
curl -s --max-time 10 \
  "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  -d "chat_id=$TELEGRAM_ALERT_CHAT" \
  -d "text=Proactive job '$job' failed: $err"
```

Then `chmod +x handler.sh` and `flopsy gateway restart`.

## Design notes

- **No retry on handler failure.** Hooks are best-effort. If you need durability, write to a file and run your own pickup loop.
- **No event filtering DSL.** The agent's `events:` list is matched literally + wildcard suffix. If you need conditional logic, do it in your handler.
- **Loading is one-shot.** New hooks require a gateway restart. Hot-reload may come later but isn't there today.
- **Environment surface area.** Shell handlers see the gateway's full environment. Sensitive vars (`*_TOKEN`, `*_SECRET`, `*_KEY`) are NOT stripped — hooks are trusted operator code.

## Source map

| File | Role |
|---|---|
| `src/gateway/src/hooks/types.ts` | Schema (`HookConfigSchema`, `HookContext`, `HookHandler`) |
| `src/gateway/src/hooks/loader.ts` | Disk → registry |
| `src/gateway/src/hooks/registry.ts` | `emitHook`, subscriber dispatch, concurrency cap |
| `src/gateway/src/hooks/index.ts` | Public exports |
| `src/cli/src/ops/hooks-command.ts` | `flopsy hooks list` |
| `.flopsy/content/hooks/boot/` | Bundled reference TS hook |
| `.flopsy/content/hooks/shell-boot-log/` | Bundled reference shell hook |
