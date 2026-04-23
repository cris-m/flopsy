---
name: scheduler
compatibility: Designed for FlopsyBot agent
description: Creating and managing scheduled jobs — reminders, recurring prompts, and time-based automations. Use when the user wants something to happen at a specific time or on a recurring schedule.
---

# Scheduler

The scheduler runs time-based automations. Jobs can deliver static messages (reminders) or process prompts at execution time (smart recurring tasks). Some jobs are pre-configured by the admin, and you can create additional ones on demand. All jobs persist across gateway restarts.

## When to Use This Skill

- User wants a reminder ("remind me to call the dentist at 2pm")
- User wants something recurring ("check my email every morning at 8")
- User wants a one-time delayed message ("send me a summary in 30 minutes")
- User asks about their scheduled tasks ("what's scheduled?", "cancel my reminders")
- User wants to pause, resume, or delete a scheduled job

## Two Modes

### Message Mode — Static Text

For simple reminders and notifications. The message is delivered exactly as written.

```
schedule_bot_message(
  name: "Dentist reminder",
  when: "tomorrow 2pm",
  message: "Call the dentist to reschedule your appointment",
  channel: "telegram",
  peerId: "5257796557"
)
```

**When to use:** "remind me to...", "send me a message at...", "tell me to..."

The message is prefixed with `[REMINDER]` automatically.

### Prompt Mode — Agent Processes at Execution Time

For smart, dynamic tasks. At execution time, the agent wakes up, processes the prompt with fresh context, and generates a response.

```
schedule_bot_message(
  name: "Morning email check",
  when: "every weekday at 8am",
  prompt: "Check email inbox. Summarize anything urgent or time-sensitive. Ignore newsletters and marketing. If nothing important, say so briefly.",
  delivery_mode: "conditional",
  channel: "telegram",
  peerId: "5257796557"
)
```

**When to use:** "check my email every morning", "give me a weather update daily", "summarize my calendar every evening"

The prompt is saved to a file at `/scheduler/prompts/` and read fresh each execution, so you can write detailed instructions. Agent-created prompt files are prefixed with `agent_` to distinguish them from admin-configured ones.

## Delivery Modes

Control what happens with the response:

| Mode | Behavior | Best for |
|---|---|---|
| `always` | Response always delivered to user | Reminders, briefings the user always wants |
| `conditional` | Agent decides: promote (deliver), suppress (skip), or queue (save for later) | Recurring checks where "nothing to report" is common |
| `silent` | Run in background, response not delivered to user | Self-improvement: reflect on interactions, organize memory, learn from mistakes, revisit failed tasks and research solutions during quiet hours |

**Defaults:**
- Message mode → `always` (reminders should always arrive)
- Prompt mode → `conditional` (agent decides if it's worth interrupting)

## Schedule Formats

| Format | Example | Type |
|---|---|---|
| Relative | `"in 30 minutes"`, `"in 2 hours"`, `"in 3 days"` | One-shot |
| Tomorrow | `"tomorrow 9am"`, `"tomorrow at 3:30pm"` | One-shot |
| At time | `"at 9am"`, `"at 15:00"` | One-shot (rolls to tomorrow if past) |
| Daily | `"every day at 9am"`, `"daily at 9am"` | Recurring |
| Weekly | `"every monday at 9am"`, `"every friday at 5pm"` | Recurring |
| Weekday | `"every weekday at 9am"`, `"weekdays at 8am"` | Recurring |
| Weekend | `"every weekend at 10am"` | Recurring |
| Interval | `"every 30 minutes"`, `"every 2 hours"` | Recurring |
| Cron | `"0 9 * * *"`, `"0 9 * * 1-5"` | Recurring |

## Managing Jobs

```
list_bot_scheduled_jobs()                -- see all jobs
disable_bot_scheduled_job(taskId: "id")  -- pause without deleting
enable_bot_scheduled_job(taskId: "id")   -- resume a paused job
delete_bot_scheduled_job(taskId: "id")   -- permanently remove
```

Always list jobs first to get the ID before disabling/enabling/deleting.

## Advanced Features

Some pre-configured jobs use advanced features that aren't available through `schedule_bot_message`:

- **Prerequisites** — a job can require another job to complete first (e.g., a briefing job runs a data-gathering job before composing the report)
- **Output injection** — one job's output can be injected into another's prompt, enabling pipelines
- **Context injection** — proactive context (recent deliveries, user presence, queue state) so the agent avoids repeating itself
- **Timezone support** — cron jobs can run in a specific timezone

## Prompt File Locations

| System | Path | Content |
|---|---|---|
| Scheduler jobs | `/scheduler/prompts/` | Job prompts — admin and agent-created (`agent_*`) |
| Heartbeats | `/heartbeat/prompts/` | Heartbeat prompts (admin-configured) |

You can **read** these files to see what a job or heartbeat does, and **edit** agent-created prompt files (`agent_*`) to update instructions for a recurring job. Don't modify admin-configured prompts unless the user explicitly asks.

## Writing Good Prompts

When using prompt mode, the prompt runs without conversation context — the agent starts fresh. Write prompts that are self-contained:

**Good:**
> Check the email inbox for messages received in the last 2 hours. Summarize anything that looks urgent or needs a response today. If nothing important, respond with just "All clear." Be concise — 3 sentences max.

**Bad:**
> Check my email.

The more specific the prompt, the better the result. Include:
- What to check or do
- How to evaluate the results (what counts as "important"?)
- What to do if there's nothing to report
- Length/format guidance

## Examples

| User says | Tool call |
|---|---|
| "Remind me to buy milk tomorrow morning" | `schedule_bot_message(name: "Buy milk", when: "tomorrow 9am", message: "Buy milk!")` |
| "Check my calendar every morning" | `schedule_bot_message(name: "Calendar check", when: "every day at 8am", prompt: "List today's calendar events...", delivery_mode: "always")` |
| "Remind me in 30 minutes to take a break" | `schedule_bot_message(name: "Break", when: "in 30 minutes", message: "Time for a break!")` |
| "What reminders do I have?" | `list_bot_scheduled_jobs()` |
| "Cancel the morning email check" | `list_bot_scheduled_jobs()` → find ID → `delete_bot_scheduled_job(taskId: id)` |
| "Pause all my reminders" | `list_bot_scheduled_jobs()` → `disable_bot_scheduled_job` for each |
| Morning briefing creates day's reminders | Multiple `schedule_bot_message` calls: one per meeting (reminder), one per important meeting (prep), one per meeting end (action items) |

## Guidelines

- Always use `channel` and `peerId` from the current conversation context — never guess these
- Use message mode for simple reminders, prompt mode for anything that needs the agent to think
- Prefer `conditional` delivery for recurring prompts to avoid notification fatigue
- One-shot jobs auto-disable after firing — no cleanup needed
- All agent-created jobs persist across restarts
