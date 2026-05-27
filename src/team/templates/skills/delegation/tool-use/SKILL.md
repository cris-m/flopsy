---
name: tool-use
category: delegation
compatibility: Designed for FlopsyBot agent
description: Effective patterns for using MCP tools and external integrations. Use when deciding which tools to call, how to chain them, or troubleshooting tool failures.
when-to-use: "Use as a baseline discipline whenever you reach for any tool — covers verifying tool output, iterating instead of one-shotting, and citing what you actually saw."
metadata:
  flopsy:
    agent-affinity: [*]
---

# Tool Use

Patterns and best practices for selecting, sequencing, and troubleshooting MCP tool calls.

## When to Use This Skill

- Deciding which tool to use for a given task
- Chaining multiple tools together in a workflow
- Diagnosing why a tool call failed or returned unexpected results
- Understanding tool limitations before committing to an approach

## Tool Selection Framework

### Step 1: Identify the Action
What does the user actually need to happen? Translate the request into a concrete action:
- "Send a message" -> identify the channel (WhatsApp, Telegram, Discord, etc.)
- "Find a file" -> identify the storage (Drive, Obsidian, local filesystem)
- "Check the schedule" -> identify the calendar (Google Calendar, Apple Calendar)

### Step 2: Match to the Right Tool
Each skill has a tools table listing available tools. Pick the most direct tool for the action. **Trivial questions get a single call. Non-trivial questions get an iterative plan — see Iteration Discipline below.**

### Step 3: Gather Parameters
Read the tool's parameter requirements. Collect any missing values from the user or from prior context before calling the tool. Do not guess required parameters.

## Iteration Discipline — the most important section

Default to **multiple tool calls per non-trivial turn.** A single call followed by a confident answer is the most common failure mode in this codebase. Claude-class agents that feel "smart" are running 3-7 calls per turn — probing, narrowing, verifying — before producing the final reply.

### When one call is enough

- Trivial factual lookup with unambiguous input (`gmail_unread_count`, `weather_today` for a known location)
- Direct tool action with no decision branch (`send_message` to a known peer)
- The user explicitly framed the request as one-shot ("just check X")

### When one call is NEVER enough

- "How many X are there" / "What's the state of X" — needs **triangulation** (3-5 query variants comparing counts)
- Any query against ambiguous strings ("openclaw", "apache") — name collisions hide in single-query results
- Investigation of a specific entity (IP, domain, file hash) — probe multiple data sources
- "Find / search for" queries — first call narrows; second call drills in
- User questions about THEIR own systems — check your `<agent_memory>` block first (USER.md / MEMORY.md may already answer), THEN the external tool

### The iteration loop

```
Plan       ── what 3-5 calls do you expect to make? rough order?
Probe      ── cheapest / freest call first to gauge result space
Branch     ── results too broad? narrow. too narrow? widen or pivot.
Verify     ── one independent call to sanity-check the headline finding
Deliver    ── only NOW write the user-facing answer
```

### Cost-aware probing

Many tools have a free `count` / `aggregate` / `peek` endpoint and a paid `search` / `detail` endpoint. **Always use the free one first.** Tool descriptions mark cost — read them.

Examples (the pattern, not exhaustive):

| Tool family | Free first | Paid only after free narrows |
|---|---|---|
| Shodan | `shodan_host_count` (with `facets`) | `shodan_search` |
| VirusTotal | `vt_get_*` (cached lookups) | active rescan / detonation |
| Web search | One broad query | Multiple deep extractions on selected URLs |
| Gmail/Drive | metadata-only list | full body fetch |

### Self-verification before delivering

Before sending the final answer, ask yourself:

- Is this conclusion supported by **more than one** of my tool calls?
- Did any of my results contradict each other? (If yes, surface the conflict; don't just pick one.)
- For ambiguous input terms — could this mean something other than what I assumed?
- For user-specific questions — did I check memory before answering?

If any of those questions land "no" or "uncertain," **make one more call** before delivering.

## Tool Chaining Patterns

### Sequential Chain (output feeds into next input)
```
1. contacts_search("John") -> returns resourceName
2. gmail_send(to: john_email, ...) -> sends the email
```
Each tool's output becomes the next tool's input.

### Parallel Calls (independent operations)
When two tools do not depend on each other, call them simultaneously:
```
1. calendar_list(date: today)    -- in parallel --    gmail_list(labelIds: ["UNREAD"])
2. Present both results together
```

### Fallback Chain (try primary, fall back on failure)
```
1. Try primary source
2. If error -> try secondary source
3. If still error -> inform user with context
```

## Error Handling

| Error Type | Likely Cause | Resolution |
|------------|--------------|------------|
| Authentication expired | Token or session lapsed | Re-authorize via the appropriate auth flow |
| Permission denied | Scope not granted | Check OAuth scopes or integration permissions |
| Rate limit exceeded | Too many calls in a short window | Wait and retry; back off exponentially |
| Not found | Invalid ID or deleted resource | Verify the ID from a fresh list or search |
| Validation error | Missing or malformed parameter | Check parameter types and required fields |

## Channel Messaging Discipline

When a message arrives from a channel (Telegram, Discord, WhatsApp, etc.), `send_message` is your **only** way to talk to the user. Your plain text output is invisible — only `send_message` and `send_poll` deliver content to the channel.

### Turn Flow

A typical turn looks like this:

1. **Status update** (optional) — tell the user you're working on it: `send_message("Looking into that...")`
2. **Do work** — research, compute, run tools, call subagents
3. **Final answer** — `send_message("Here's what I found: ...")`
4. **DONE** — stop calling tools. Your turn is over.

Status updates (step 1) are valuable — they tell the user you're on it, especially for tasks that take time. But once you deliver the actual answer (step 3), **your turn is done**. The user will message you when they need more.

### What NOT to do after your final answer

- Do not send "Would you like me to...", "Let me know if...", "Anything else?"
- Do not rephrase or summarize what you just said
- Do not call `write_todos` to plan unprompted follow-ups
- Do not send another `send_message` with the same content

### Stop Compliance

When the user says "stop", "enough", "done", or similar — immediately cease ALL tool calls. No "one more message". No "are you sure?". Override everything else.

### Polls vs Buttons — Decision Framework

`send_message`, `send_poll`, and `send_message({ components })` are channel-aware — they adapt to what each channel supports:

| Tool | Native on | Fallback on other channels |
|------|-----------|---------------------------|
| `send_poll` | Telegram, Discord | Numbered text list — ask user to reply with a number |
| `send_message({ components })` (buttons/menus) | Telegram, Discord | Silently ignored — ask user to reply with their choice as text |
| `send_message` (text/media) | All channels | — |

**When to use which:**

| Use this | When | Example |
|----------|------|---------|
| `send_poll` | You will **record** the user's preference | "What cuisine tonight?", "Rate 1-5", "Which time slot?" |
| `send_message({ components })` | You will **execute** an action based on the choice | "Deploy / Cancel", "Accept / Revise", "Confirm / Abort" |

**Decision test:** Will you DO something based on the click? → Buttons. Will you LEARN something? → Poll.

Never use `send_poll` for action triggers like "Deploy/Cancel" — those are actions that need buttons on channels that support them, or a plain text prompt ("Reply Deploy or Cancel") on channels that don't.

## Anti-Patterns to Avoid

- **Guessing IDs**: Always retrieve IDs from list or search results; never fabricate them
- **Ignoring errors**: If a tool returns an error, stop and handle it before continuing
- **Over-fetching**: Do not list 1000 items when you need 1; use search or filters
- **Redundant calls**: Do not call the same tool twice with the same parameters in one session
- **Skipping confirmation**: For destructive actions (delete, send, post), confirm with the user first

## Guidelines

- Read the skill documentation for a tool before using it; each skill defines the tool's parameters and quirks
- When in doubt about a tool's behavior, start with a read-only call (list, search, get) before trying a write call
- Log tool call results mentally; if a later step fails, the earlier results provide context for debugging
- If a tool is consistently failing, check whether the underlying service (API, app, session) is healthy before retrying
