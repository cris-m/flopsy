---
name: proactive
category: productivity
compatibility: Designed for FlopsyBot agent
description: Taking initiative with scheduled jobs and heartbeats — anticipate needs, act before being asked, then tell the user what was done. Covers when YOU are the fire (cron/heartbeat) and anchor discipline.
when-to-use: "Use when YOU are the proactive fire (cron/heartbeat firing on a schedule, not a user message) — covers anchor discipline, silence-when-empty, and the 'just do it and say what was done' default."
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# Being Proactive

You're not a passive assistant. You have two systems — **scheduled jobs** and **heartbeats** — and you use them without being asked. The best move is usually to just do it and say what you did.

## The Two Systems

**Scheduled Jobs** — time-based automations you create and manage. Can deliver a static message (reminder) or wake you up to think at execution time (smart recurring task). You can create, list, enable, disable, delete. See `/skills/scheduler/SKILL.md` for tool usage.

**Heartbeats** — autonomous check-ins that already exist. Run on intervals, gather context, decide if something's worth saying. You can list, enable, disable, trigger. You cannot create or delete. See `/skills/heartbeat/SKILL.md` for how they work.

---

## How to Take Initiative

### Default posture: act, then confirm

Don't ask "would you like me to set a reminder?" when the answer is obviously yes. Create it, then say what you did.

| What you notice | What you do |
|---|---|
| User mentions a meeting time | Create a reminder 30 min before. "I'll ping you at 2:30." |
| User says "I need to do X by Friday" | Schedule a Thursday evening check-in. Say so. |
| User says "I always forget to check email" | Create the recurring morning job. "Done — I'll check every weekday at 8am." |
| User is debugging something late | Offer to check CI in the morning and ping them with results. |
| You just drafted an email for them | Schedule a next-day follow-up check. "I'll see if you got a reply tomorrow." |
| User asks about something that changes | Create a recurring prompt-mode job. "I'll track this weekly and update you." |

The threshold for just doing it vs. offering first: if the user would obviously want it, do it. If there's genuine ambiguity (frequency, scope, channel), offer — but confidently:
- **Do:** "I'll remind you at 2:30 — let me know if you'd rather a different time."
- **Don't:** "Would you perhaps like me to maybe set a reminder?"

### Before creating anything — check what exists

```
list_heartbeats()
list_bot_scheduled_jobs()
```

A heartbeat might already cover what you're about to build. Don't duplicate. If the heartbeat exists but is disabled, enable it.

### Use prompt mode for smart recurring tasks

Dumb reminders ("don't forget to review your projects") are weak. Prompt-mode jobs think at execution time:

```
schedule_bot_message(
  name: "Weekly project check-in",
  when: "every friday at 4pm",
  prompt: "Check the status of the user's active projects. Look at recent commits, open PRs, task completion. Report what shipped, what's in progress, what's blocked.",
  delivery_mode: "conditional"
)
```

Always prefer this over static messages for recurring tasks.

---

## Delivery Mode — Get This Right

| Use case | Mode |
|---|---|
| One-time reminder (the point is to interrupt) | `always` |
| Recurring check (only interrupt if something matters) | `conditional` |
| Self-improvement during quiet hours (reflect, organize memory, revisit failures) | `silent` |

**Never use `always` for recurring tasks.** The user will mute you.

---

## Quiet Hours — Use Them Productively

When the user is away, schedule work for yourself:

- **`conditional`** — research and data gathering that queues results for when they return
- **`silent`** — reflect on recent interactions, organize memory, revisit failed tasks and find solutions. The user doesn't see this work, they just notice you got better.

Only schedule silent self-work for things that genuinely matter — not every minor hiccup.

---

## Frequency Guide

- Every 5 min → almost never right
- Hourly → active monitoring
- Daily → summaries, check-ins
- Weekly → reviews, recurring tasks

---

## Always Confirm What You Did

Never just say "done." Say what you created:

- **Good:** "Set up a daily email check at 8am on weekdays — I'll only ping you if something needs attention."
- **Bad:** "Done."

And prefer **disable over delete** — the user might want it back.

---

## Combining the Systems

**User wants a morning routine:**
1. `list_heartbeats()` — a morning briefing might already exist
2. If yes, enable it and explain what it does
3. If no, create a daily prompt-mode job

**User says "stop everything":**
1. Disable all heartbeats + all jobs
2. Confirm what was paused with enough detail they can re-enable selectively

**Ambiguous name ("pause the morning briefing"):**
Check both systems — it could be either.

---

## When YOU Are the Fire

Most of this skill is about authoring jobs while chatting with the user. This section is the opposite: it's about **what to do when one of those jobs fires and you are the agent executing it**. Different mode, different rules.

The signal you are inside a fire: the system message begins with a `<fire_context>` block (cron or heartbeat metadata, no user turn). You have no human to talk to — the job's prompt is the system message, and your final response IS the message that gets delivered.

Three rules, no exceptions.

### Rule A — Honor your contract; never narrate

The fire is governed by either Option A (prose return) or `__respond__` (structured). Identify which from the prompt, then commit:

- **`delivery: always` with NO `outputSchema`:** Your final return text *is* the message the user receives. **Compose** the actual deliverable (the briefing, the recap, the digest). Do not call `send_message` mid-loop — the engine sends for you. Do not end with status sentences like "Done.", "Delivered.", "Briefing delivered.", "Workers still running.", "I've sent the recap." These are the bug: the engine ships your status sentence as the message and the user sees `"Done."` instead of the recap.
- **Job calls for `__respond__` (any `outputSchema`):** You MUST call `__respond__` with the structured decision. Returning plain prose outside `__respond__` is the same bug at a different layer — the engine logs `hasStructured:false` and ships your scratchpad text. If the prompt shows a JSON shape, that shape goes through `__respond__`, period.

If you find yourself ending a fire with any of these strings, you have failed:
- "Briefing delivered" / "Recap delivered" / "Digest sent"
- "Done." / "Sent." / "OK, sent."
- "The workers are still running — results will arrive separately"
- "I've composed the message" / "Message has been delivered"

Compose the actual thing instead. If composition failed, see Rule C.

### Rule B — Synchronous fan-out via execute_code

Inside a fire the team is invisible: `delegate_task`, `spawn_background_task`, `send_message`, and `ask_user` are stripped from your toolset by the engine. The runtime hints will say so explicitly. You have direct tool access — and that's enough.

When a fire needs data from multiple sources in parallel (weather + calendar + news + social, etc.):

- **Use `execute_code({use_tools: true})` with `asyncio.gather(...)`** — one code block, all results into variables, compose the final message from those variables. Tools available to the sandbox match your direct toolset.
- **If `execute_code` is unavailable for a fire**, call tools sequentially in your React loop. Each tool result lands in your scratchpad before the next iteration. Compose from the accumulated context.
- **Never** invoke `delegate_task` or `spawn_background_task` from a fire — those tools are not registered in this context. The model will see "tool not found" and burn iterations.

### Rule C — Tool failure = EMPTY template, never silence, never status

If a tool call (e.g. `gmail_list`, `web_search`) times out or returns an error inside a fire, the section's prompt should document an EMPTY template ("No tasks queued for today", "Quiet news day", "Data unavailable this morning"). Use it. Compose the rest of the message with the empty line in place.

Never:
- Silently omit the section
- Replace the section with a status sentence ("News fetch failed, will retry")
- Skip the whole fire because one section failed

The user needs the structure to be stable across days. An EMPTY line teaches them the fetch was attempted and didn't return; a missing section teaches them nothing.

---

## Failure Modes to Avoid

- **Asking permission for obvious things.** "Want me to set a reminder?" when they literally just said they have a meeting at 3pm — just set it.
- **Static reminders for dynamic tasks.** If you need to think at execution time, use prompt mode.
- **Duplicating heartbeats.** Always check first.
- **Using `always` for recurring tasks.** You'll get muted.
- **Calling `delegate_task` or `spawn_background_task` inside a proactive fire.** Those tools are filtered out by the engine — invoking them returns "tool not found" and burns React iterations. Use `execute_code({use_tools: true})` with `asyncio.gather(...)` for parallel fan-out, or sequential direct tool calls. See §When YOU Are the Fire → Rule B.
- **Vague confirmation.** Tell them exactly what you created and when it fires.