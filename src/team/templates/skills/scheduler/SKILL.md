---
name: scheduler
description: Create, list, edit, or remove scheduled fires (heartbeats + cron) via the single `manage_schedule` tool. Use when the user wants something to happen at a specific time, on a recurring interval, or "in N minutes".
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# Scheduler

One tool: `manage_schedule`. Six operations: `create | list | update | delete | disable | enable`. Two schedule types: `heartbeat` (interval-based) and `cron` (wall-clock).

## Pick the schedule type

| User asks | Type | Example |
|---|---|---|
| "remind me in 2 hours to call mom" | `cron`, `cronKind: "at"`, `oneshot: true` | One-shot fire at an absolute time |
| "check my inbox every 30 minutes" | `heartbeat`, `interval: "30m"` | Repeats forever on a simple interval |
| "every Monday at 9am give me a briefing" | `cron`, `cronKind: "cron"`, `cronExpr: "0 9 * * 1"` | Standard 5-field cron |
| "fire once at 8pm tonight" | `cron`, `cronKind: "at"`, `oneshot: true`, `atMs: <epoch ms>` | One-shot |
| "every 90 seconds, do X" | `cron`, `cronKind: "every"`, `everyMs: 90000` | Fixed interval below cron's 1-min granularity |

## Create — heartbeat

A heartbeat fires repeatedly on a simple interval string.

```
manage_schedule({
  operation: "create",
  scheduleType: "heartbeat",
  name: "morning inbox check",
  interval: "30m",
  prompt: "Read my inbox. If anything urgent, send a one-line summary.",
  deliveryMode: "conditional",
  activeHoursStart: 8,
  activeHoursEnd: 22
})
```

- `interval` string format: `<N>s` `<N>m` `<N>h` `<N>d` (e.g. `30s`, `15m`, `2h`, `1d`)
- `activeHoursStart` / `activeHoursEnd`: 0-23, optional. Outside this window the heartbeat sleeps.

## Create — cron

A cron job fires on a wall-clock schedule. Three flavours via `cronKind`:

```
// "fire once tomorrow at 9am Africa/Nairobi"
manage_schedule({
  operation: "create",
  scheduleType: "cron",
  name: "tomorrow 9am reminder",
  cronKind: "at",
  atMs: 1779062400000,
  oneshot: true,
  prompt: "Tell the user it's 9am."
})

// "every Monday 9am, weekly review"
manage_schedule({
  operation: "create",
  scheduleType: "cron",
  name: "weekly review",
  cronKind: "cron",
  cronExpr: "0 9 * * 1",
  cronTz: "Africa/Nairobi",
  prompt: "Generate a weekly review covering last week's commitments + open threads."
})

// "every 90 seconds (faster than cron's 1-min granularity)"
manage_schedule({
  operation: "create",
  scheduleType: "cron",
  name: "fast pulse",
  cronKind: "every",
  everyMs: 90000,
  prompt: "ping the health check"
})
```

## Delivery modes

| Mode | Behaviour |
|---|---|
| `always` (default) | The agent's reply is delivered to the user every fire |
| `conditional` | The agent returns structured JSON; only `shouldDeliver: true` gets sent |
| `silent` | Agent runs for side-effects only; nothing reaches the user |

Pick `conditional` for "only ping me when interesting" patterns. Pick `silent` for state-keeping that shouldn't bother the user.

## List, update, delete

```
manage_schedule({ operation: "list" })

manage_schedule({ operation: "delete", id: "cron:weekly-review" })
manage_schedule({ operation: "disable", id: "hb:morning-inbox-check" })
manage_schedule({ operation: "enable",  id: "hb:morning-inbox-check" })

manage_schedule({
  operation: "update",
  id: "cron:weekly-review",
  cronExpr: "0 9 * * 5",      // change Mon → Fri
  prompt: "Friday recap instead of weekly review."
})
```

Schedule IDs come back from `create` and `list` — they're `cron:<slug>` or `hb:<slug>`. The literal id `tick` is reserved.

## Anti-repetition is built in

You don't have to tell the agent "don't repeat last fire's message" — the proactive engine tracks topic + reported-item IDs + embedding similarity across fires automatically. Just write a clear prompt; the engine handles dedup.

## When to use this vs the alternatives

- **Use `manage_schedule`** for anything that fires later, recurring or one-shot.
- **Use `spawn_background_task`** for "do this now, but it takes a while — deliver the result whenever it's ready." That's not a schedule; it's an async task.
- **Use `delegate_task`** for "do this and tell me the answer before I reply." Synchronous, no scheduling.

## Common mistakes

- Inventing tool names like `schedule_bot_message` or `list_bot_scheduled_jobs`. There is **one** tool: `manage_schedule`.
- Passing `peer_id` / `channel` — those come from the calling context, not the tool args.
- Forgetting `cronKind` on a cron schedule. Required when `scheduleType: "cron"`.
- Using `everyMs` below 60_000 (1 minute). The schema rejects it.
- Setting `cronTz` on `cronKind: "at"` or `cronKind: "every"`. Timezone applies only to `cronKind: "cron"` expressions.
