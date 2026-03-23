---
name: heartbeat
compatibility: Designed for FlopsyBot agent
description: Proactive periodic check-ins that gather context and take action without user prompting. Use when running scheduled heartbeat routines or understanding heartbeat behavior.
---

# Heartbeat

Heartbeats are periodic, autonomous agent runs that gather context and optionally take action without waiting for user input. They keep the system aware and responsive.

## When to Use This Skill

- A heartbeat is triggered by the scheduler and needs to execute its routine
- You need to understand what a specific heartbeat does or how to configure one
- You want to add or modify heartbeat behavior

## How Heartbeats Work

Heartbeats are defined in `config/heartbeats.yaml`. Each heartbeat has:
- **name**: Identifier for the heartbeat
- **interval**: How often it runs (cron expression or interval string)
- **description**: What the heartbeat is meant to monitor or do
- **actions**: The steps to take on each run

State between runs is persisted in `.flopsy/heartbeats/states/{name}.json`.

## GATHER-First Pattern

Every heartbeat should start by gathering context before deciding what to do:

1. **GATHER**: Collect current state (emails, calendar, messages, system metrics, etc.)
2. **ASSESS**: Evaluate the gathered data against the heartbeat's purpose
3. **ACT** (if needed): Take action based on the assessment
4. **REPORT** (if needed): Notify the user only if something requires their attention

## Delivery Modes

Heartbeats use `delivery_mode` to control when output is delivered:

- **always**: Every run delivers output to the user
- **conditional**: Agent decides whether to deliver using structured output (default)
- **silent**: Runs in background, never delivers output

### Conditional Delivery (Structured Output)

When `delivery_mode: conditional`, the agent must return a JSON decision:

```json
{
  "status": "promote" | "suppress" | "queue",
  "reason": "brief internal justification",
  "content": "user-facing message"
}
```

**Status meanings:**
- **promote**: Deliver content immediately (urgent/actionable)
- **suppress**: Silent success (nothing noteworthy found)
- **queue**: Save for later delivery when user is active (non-urgent)

**When to promote:**
- Urgent email or message arrives
- Calendar conflict detected
- Monitored system unhealthy
- Threshold or alert condition met

**When to suppress:**
- Everything is normal, no action needed
- Gathered data is routine and expected

**When to queue:**
- Interesting but non-urgent information
- Updates that can wait until user is active

## Common Heartbeat Types

| Heartbeat | Monitors | Acts On |
|-----------|----------|---------|
| inbox-watch | Email inbox | Flags urgent or time-sensitive emails |
| heartbeat (main) | General system state | Surfaces anything requiring attention |
| news-digest | News and social feeds | Summarizes important items periodically |
| market-watch | Financial data | Alerts on significant price movements |
| auth-watch | Authentication tokens | Warns before tokens expire |

## State Management

Each heartbeat persists its state between runs:
- Use state to track what has already been processed (e.g., "last email ID seen")
- Compare current state to previous state to detect changes
- Update state at the end of each run

## Guidelines

- Heartbeats should be lightweight; avoid long-running or blocking operations
- Always read the previous state before gathering new data to avoid re-processing
- If a heartbeat fails, log the error to state and do not crash the scheduler
- New heartbeats should be added to `heartbeats.yaml` and tested manually before enabling in production
- Heartbeat output should be concise; the user does not want a wall of text every few minutes
