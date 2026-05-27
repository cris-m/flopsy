---
name: delegation
category: delegation
compatibility: Designed for FlopsyBot agent (gandalf)
description: Delegate to specialist workers via delegate_task (sync) or spawn_background_task (async). Use this skill when a request shape matches a teammate's specialty better than your own kit. The auto-generated Capability Routing block in your system prompt is the authoritative source for "which teammate owns which MCP" — read it before declining a capability.
when-to-use: "Use when a request matches a teammate's specialty (Saruman: deep research, Legolas: web/news, Gimli: analysis, Aragorn: security, Sam: media/home) better than your own kit."
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# Delegation

You have specialists. Your job as the main agent is to ROUTE — not to inline-do research-shape, analysis-shape, or worker-MCP-owned work yourself.

## The Two Delegation Tools

Flopsy has exactly two delegation tools. There is no `task()` and no `subagent_type` parameter — those names are wrong.

| Tool | Behavior | When to use |
|---|---|---|
| `delegate_task(worker, task)` | **Blocks this turn** until the worker returns its final text | Short focused work (<2 min). User is waiting; result is needed before you reply. |
| `spawn_background_task(worker, task)` | Returns ticket immediately; worker pings via `<task-notification>` later | Long work (3-15 min). Send user a short ack, end your turn, deliver result when the notification fires. |

Worker names are bare strings (e.g. `"legolas"`), not enums.

## Who's on the Team

The roster is **dynamically injected** into your system prompt — read the `## Your Team` table there. The current default workers:

| Worker | Role | Owns MCPs | Best for |
|---|---|---|---|
| `saruman` | deep-research | browser | Multi-source research, state-of-X, compare-X-to-Y |
| `legolas` | research | browser, youtube | Fast single web lookups; parallelisable; YouTube |
| `gimli` | analysis | (no MCPs — toolset: utility, filesystem) | Review drafts, spot flaws, analyze attachments |
| `aragorn` | security | virustotal, shodan | Threat intel, IOC triage, CVE assessment, recon |
| `sam` | media | spotify, home-assistant | Music playback, smart-home control |

The roster updates from `flopsy.json5` `mcp.servers.<name>.assignTo` — when MCPs are added, the table refreshes. **Always read your system prompt's actual team table; this list is a reference, not authoritative.**

## How to Decide: 3 Branches

Pick the cheapest branch that works.

```
Can you answer NOW with no tool call?     → just answer
< 2 min work, user waiting THIS turn?     → delegate_task(worker, ...)
> 2 min work or no urgency?               → spawn_background_task(worker, ...)
```

## Shape → Worker Mapping

The `## Delegate by SHAPE` table in your system prompt's `AGENTS.md` is the canonical version. Summary:

| User request looks like… | Worker | Sync vs spawn |
|---|---|---|
| "research X / state of X / compare X to Y" | `saruman` | `spawn_background_task` (3-15 min) |
| "what's the latest on X" / single web lookup | `legolas` | `spawn_background_task` (<30s); fan out for many |
| "search youtube for X" / "what's in my subscriptions" | `legolas` (owns youtube MCP) | sync or spawn |
| "review this / spot flaws / analyze this draft" | `gimli` | `delegate_task` |
| "check VirusTotal / Shodan / threat intel / scan IP" | `aragorn` | `delegate_task` |
| "play music / control home / set the temp" | `sam` | `delegate_task` |
| "summarise this 4-line snippet" | yourself | inline |

**The MCP-ownership column matters most for delegation routing.** If the user asks for tools you don't own, look at who DOES own them and delegate there.

## Capability Routing — Read BEFORE Declining

Your system prompt contains an auto-generated `## Capability Routing` section listing every MCP and which worker owns it. **Before you say "I don't have that tool" or fall back to web search, scan that table.** If a teammate owns the MCP, delegate to them — that's a hard rule.

Common case the auto-generated table fixes: user asks "search youtube" → gandalf doesn't have youtube tools but `legolas` does → `delegate_task("legolas", "...")` instead of "no YouTube tools available."

## Parallelism — Same Turn, Multiple Calls

When subtasks are independent, **fire them in the same turn**. Don't serialise.

| Request | Wrong (serial) | Right (parallel) |
|---|---|---|
| "Look up news on X, Y, Z" | one legolas spawn → wait → next | 3× `spawn_background_task("legolas", ...)` in one turn |
| "Compare A and B" | one saruman spawn for "A vs B" | 2× `spawn_background_task("saruman", ...)` — one each, then synthesise |
| "Plan a refactor" | inline reason about everything | `spawn_background_task("saruman")` for context research + your inline planning concurrently |

## Mechanics

### Sync (`delegate_task`)

1. Call `delegate_task(worker, task)` — pass FULL context inline, workers have NO memory of this conversation
2. Tool blocks; you receive the worker's final text
3. **Reframe** the worker's output for THIS user and THIS channel — never dump raw worker output

### Async (`spawn_background_task`)

1. Call `spawn_background_task(worker, task)` — same full-context rule
2. Send a brief ack to the user ("on it — back in a moment"). End the turn.
3. The worker will ping back via `<task-notification>` in a later turn
4. Deliver the result via `send_message` (or normal reply if you're in the user's thread already)

## Anti-patterns

| Bad | Why |
|---|---|
| `task(subagent_type="swarm", ...)` | **The `task()` tool does not exist in Flopsy.** Use `delegate_task` or `spawn_background_task`. |
| `delegate_task("coder", ...)` / `"swarm"` / `"productivity"` | Wrong worker names. The actual workers are saruman/legolas/gimli/aragorn/sam (read your system prompt). |
| Saying "I don't have that tool" without checking the roster | Read the Capability Routing table first. If a teammate owns the MCP, delegate. |
| Delegating with `"write about X"` (no context) | Workers are stateless. Pass research, sources, voice/format, channel hints — everything they need. |
| Dumping raw worker output verbatim | Always rewrite in your voice and shape it for the current channel. |
| Forgetting to include channel format in the delegation | Workers can't see the channel; tell them ("Discord — full markdown" / "Telegram — under 4000 chars, no preview-breaking tables"). |
| Serialising independent subtasks | Fan out in the same turn. |

## Lessons Learned

- **Parallel delegation works**: fire multiple `delegate_task` / `spawn_background_task` calls in the same turn; results arrive concurrently. Do not chain artificially.
- **In-flight tasks survive most failures**: if a session restarts mid-delegation, check the task registry on recovery and re-fire any pending tasks that never delivered.
- **When delegation fails, test the worker directly** before assuming the plumbing is broken — often the worker's model endpoint is the issue, not delegation itself.
- **`spawn_background_task` returns a ticket synchronously** (e.g. `#t2 started → legolas`); the actual result arrives later as a `<task-notification>` event, not in the call's return body.
