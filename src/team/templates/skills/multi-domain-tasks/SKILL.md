---
name: multi-domain-tasks
description: Recognise when a user request touches more than one worker's domain and fan it out via parallel `delegate_task` calls. Use whenever the work splits into independent sub-tasks (research + summary, scan + report, news across N sources, security check + explanation).
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# Multi-domain tasks → delegate, don't serialize

When a request asks for work across more than one worker's domain, **default to delegating**. The cost of a worker round-trip is small; the upside is each piece is handled by the right specialist with their tuned toolset.

## How to recognise a multi-domain request

The request mentions, implies, or requires **two or more** of these:

- web search / current events / news → `legolas`
- deep multi-source briefing with citations → `saruman` (use `spawn_background_task`, not `delegate_task` — saruman is slow)
- analysis, code review, vault search (Obsidian / Notion / Apple Notes) → `gimli`
- security intel (VirusTotal, Shodan, sandbox triage) → `aragorn`
- media + home control (Spotify, Home Assistant) → `sam`

If the answer crosses two or more buckets, it is a multi-domain task. Fan out.

## Patterns

### Pattern 1 — Parallel research across N sources

> "Find recent news on Anthropic across HN, X, and the official blog."

Three independent web fetches → three `legolas` calls in a **single** assistant turn. They run concurrently and all results return together before your next step. Never serialise this.

```
delegate_task(legolas, "search HN for recent Anthropic posts (last 7 days). Return titles + URLs + 1-line summaries.")
delegate_task(legolas, "search X for recent @AnthropicAI posts (last 7 days). Return tweet text + URLs.")
delegate_task(legolas, "fetch the Anthropic blog index and list new posts from the last 7 days.")
```

Then synthesise the three replies into one user-facing message.

### Pattern 2 — Sequential pipeline (research → analysis)

> "Research the state of post-quantum crypto and write me a 2-page brief."

This is a **long, deep** task. Use `spawn_background_task(saruman)` — it returns immediately with a ticket and the result arrives via task-notification. Don't block the user's turn waiting.

```
spawn_background_task(saruman, "Brief on post-quantum cryptography state in 2026. Cover NIST PQC standards, deployment status at major CAs, performance trade-offs vs RSA/ECC. 2 pages, citations required.")
```

When it returns, you may chain a second worker for analysis or summarization if needed.

### Pattern 3 — Cross-domain validate-then-explain

> "Is this URL malicious, and if so, what does it do?"

Security check first → if flagged, explain. Two workers, sequential.

```
delegate_task(aragorn, "Check https://example.com/foo with VirusTotal + Shodan. Return: verdict, detection count, hosting AS, any IOCs.")
// review aragorn's result
// if malicious → either explain yourself from aragorn's IOCs, or fan out a second delegate for context
```

### Pattern 4 — Vault search + summarize

> "Pull my notes on the Q3 roadmap and give me a 5-bullet summary."

`gimli` for the vault search, then either gimli does the summary inline (same delegate, ask for the bullet format) **or** you fold the raw notes yourself if short.

```
delegate_task(gimli, "Search Obsidian vault for notes tagged #q3-roadmap from the last 6 months. Return the matching note bodies plus a 5-bullet executive summary at the top.")
```

One delegate, two outputs — let the worker do both in one shot when the second step needs the first step's full context.

### Pattern 5 — Security + News in one go

> "What's been happening with the recent OpenSSL CVE? Is my server exposed?"

Two domains:
- `legolas` for news/CVE context
- `aragorn` for exposure check on the user's server

Fan out in parallel.

```
delegate_task(legolas, "Summarize the latest OpenSSL CVE in 2026 — number, severity, affected versions, exploit status. Cite official advisory.")
delegate_task(aragorn, "Run a Shodan check on <user's server IP/hostname> for OpenSSL version exposure.")
```

## What NOT to do

- **Don't do all the work yourself just because you can.** Specialists with tuned prompts and curated tools produce better results.
- **Don't serialise independent tasks.** Two `delegate_task` calls in one turn run in parallel; two turns waste time.
- **Don't delegate first-person data** (the user's own gmail / calendar / inbox at the user level) — your own tools already cover those when they're available.
- **Don't delegate trivial single-fact lookups** — if a fast tool call from your own toolset returns the answer in one shot, do that.

## The check before you start

Before responding to a request that looks multi-faceted, answer two questions:

1. **What are the distinct pieces of this task?** Map each piece to a worker (or to yourself).
2. **What can run in parallel?** Pieces with no dependency between them go in a single turn as multiple `delegate_task` calls.

If the answer to #1 has more than one bucket, you should be delegating.
