---
name: peer-handoff
category: delegation
description: When a task is partially or wholly outside your domain, route it sideways to the peer who owns it. Use `delegate_task` for sub-tasks (you integrate the result) or `handoff_task` for full transfers (peer's reply IS the answer). Workers help each other — don't return to gandalf with "I couldn't do it".
when-to-use: "Use when you discover a sub-task or the entire task needs tools/skills you don't have but a teammate does. The team roster in your prompt tells you who owns what — pick `delegate_task` for partial, `handoff_task` for full ownership transfer."
metadata:
  flopsy:
    agent-affinity: [legolas, saruman, gimli, aragorn, sam]
---

# Peer handoff

You are a worker on a team. When a task crosses out of your domain, your job is to route it to the right peer — not to return to gandalf with a failure.

## Two tools — pick the right one

| Tool | When | What happens |
|---|---|---|
| `delegate_task('<peer>', '<sub-task>')` | **Part** of the task is in a peer's domain, part is yours | Peer runs, returns result to you. You integrate with your own work, return a synthesized answer to gandalf. |
| `handoff_task('<peer>', original_brief, why_handoff)` | **Whole** task is in a peer's domain (gandalf routed it to you by mistake) | Peer runs, peer's reply becomes your reply unchanged. You contribute nothing. |

**Decision rule:** if you'd add anything meaningful on top of the peer's reply, use `delegate_task`. If you'd just pass it through verbatim, use `handoff_task`.

## The principle

Gandalf delegated this task to you because the FIRST step was in your domain. As you work, you may discover sub-steps that aren't. When that happens:

- **Default:** `delegate_task('<peer>', '<focused sub-task>')` — they execute, return a result to you, you incorporate it and return to gandalf with the full answer.
- **NOT:** return to gandalf saying "this requires X which I don't have, ask the user". That wastes a round-trip and leaves the user waiting.

The team roster in your prompt is the authoritative source for who does what. Read it before deciding a task is "impossible".

## When to delegate sideways

| Situation | Action |
|---|---|
| Task needs an MCP tool you don't have, but a peer does | `delegate_task('<owning peer>', ...)` |
| Task crosses domains (e.g. you got a research task that ends in posting to social) | Do your part, then `delegate_task('<social-owner>', ...)` with the result |
| A skill you'd need is tagged to another worker (`agent-affinity`) | `delegate_task('<owner>', ...)` — they have the skill, you don't |

## When NOT to delegate sideways

- The task is fully inside your domain — finish it yourself
- You'd be delegating back to a peer earlier in the chain — loops are blocked at depth 3, but more importantly, don't create churn
- The sub-task is trivial and you can do it with your existing tools (e.g. one `web_search` call) — don't over-delegate

## Worked examples

### Example 1 — `delegate_task` (partial, you integrate)

**Task gandalf gave aragorn (security worker):**
> "Check if my voice-agent container is exposed to the vm2 CVE that dropped today. Pull the advisory, then check our internal logs for any matching exploit attempts in the last 24h."

**aragorn's reasoning:**
- Pulling the CVE advisory → legolas's domain (research)
- Checking gateway logs → aragorn's domain (security)
- Both parts contribute to the final answer — this is `delegate_task`, not handoff.

**aragorn acts:**
```
delegate_task("legolas", "Fetch CVE-2026-1234 advisory (vm2). I need: severity, affected versions, exploit mechanism, fix version. Reply with extracted facts only, no commentary.")
```
Receives legolas's reply. Runs `check_gateway_logs(query="vm2|sandbox-escape", limit=50)` itself. Synthesizes both into a single report for gandalf.

### Example 2 — `handoff_task` (full transfer)

**Task gandalf gave aragorn:**
> "Post a tweet about today's vm2 CVE."

**aragorn's reasoning:**
- Twitter posting → not aragorn's domain at all. Gandalf misrouted.
- aragorn would just pass through whatever the social worker says.
- Use `handoff_task`.

**aragorn acts:**
```
handoff_task("legolas", "Post a tweet about today's vm2 CVE.", "Twitter posting is legolas's domain — I have no social tools.")
```
legolas's reply becomes aragorn's reply unchanged. aragorn contributed nothing.

### Wrong move (in both cases)
> aragorn returns to gandalf: "I can't do this — can you ask legolas?"

That wastes a round-trip. Aragorn has the team roster — aragorn should route.

## Chain limits

The harness blocks loops automatically. Max chain depth is 3 (gandalf → aragorn → legolas → aragorn_back is the deepest valid path). You can't accidentally re-delegate to someone already in the chain.

If you hit the depth cap and still need more help, return to gandalf with what you have plus a note about what's still needed.

## Reply shape (when you return to gandalf)

If you delegated to peers, fold their work into your answer. Don't return a transcript of who did what — return the synthesized result with a brief note about the path.

> ✓ `"vm2 CVE-2026-1234 (critical, RCE on host, affects 3.0–3.9.17, fix 3.9.18+). No exploit attempts in last 24h gateway logs. Recommendation: bump Dockerfile vm2 pin. [pulled advisory via legolas, logs checked locally]"`

> ✗ `"I asked legolas to look up the CVE. He said it's CVE-2026-1234. Then I ran the log check. No hits."`

The user doesn't care which worker did which step. Gandalf cares only enough to credit-route on the next similar task. One synthesized answer is the right shape.
