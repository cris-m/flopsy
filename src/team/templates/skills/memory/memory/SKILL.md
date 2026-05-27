---
name: memory
category: memory
description: How to use the typed `memory` tool to persist user facts and agent notes across sessions. Two stores (user, memory), three actions (add, replace, remove), substring-based identification. The ONLY supported write path for /memory/*.md.
when-to-use: "Use BEFORE persisting anything across sessions — covers which target fits (user profile vs agent notes), how to do surgical updates (replace by old_text), and what does NOT belong in memory."
metadata:
  flopsy:
    agent-affinity: [*]
---

# Memory

You have one tool — `memory` — for durable, cross-session storage. It writes to two files:

- `/memory/USER.md` — who the user is (name, location, role, preferences, communication style)
- `/memory/MEMORY.md` — everything else worth recalling (project state, environment facts, tool quirks, lessons)

Both files are loaded into your `<agent_memory>` block at session start. The tool is the **only** supported write path. `write_file` / `edit_file` on `/memory/*` is read-only at the filesystem layer and will fail.

## The tool

```
memory({ action: "add" | "replace" | "remove", target: "user" | "memory", content?: string, old_text?: string })
```

| Action | Required args | Effect |
|---|---|---|
| `add` | `target`, `content` | Append a new entry. Refused if char-limit exceeded. |
| `replace` | `target`, `old_text`, `content` | Find the unique entry containing `old_text`, replace it with `content`. Multi-match → refused (pick a more specific substring and retry). |
| `remove` | `target`, `old_text` | Delete the matching entry. Same multi-match rule. |

Returns JSON: `{success, message, entry_count, usage}` on success; `{success: false, error}` with the matched candidates on ambiguous `old_text`.

## When to write (proactively, do not wait to be asked)

- User states a stable fact about themselves: `"I'm Alex"`, `"I work in Tokyo"`, `"I prefer terse replies"` → `memory({action: "add", target: "user", content: "..."})`
- User corrects you (`"don't do X"`, `"I told you Y last time"`) → encode the rule so it sticks across sessions
- User says `"remember this"` / `"save that"` → take them literally
- You discover an environment fact, project convention, or tool quirk worth keeping → `target: "memory"`

## Contradiction handling

When new info supersedes an old fact (`"I moved from Berlin to Amsterdam"`), **always replace**, never add:

```
memory({ action: "replace", target: "user", old_text: "Berlin", content: "Location: Amsterdam" })
```

Never `add` a contradicting line. That leaves both versions in memory and corrupts the profile.

## What NOT to save

Skip ephemera. Memory is small and dense — every entry competes for context budget.

- Task progress, completed work, session outcomes
- Raw data dumps (paste of an email, full search result)
- Things you can re-discover trivially (`git log`, file contents)
- PRs, commit SHAs, "fixed bug today"
- Anything the user did NOT state

If you're unsure whether something belongs in memory, it probably doesn't.

## Read, don't search

To recall what's stored, **read your `<agent_memory>` block at the top of your prompt** — the current USER.md and MEMORY.md content is already loaded for this session. There is no `memory_search` tool. Mid-session writes hit disk immediately but the snapshot in your prompt won't update until the next session — the tool's success response is your confirmation it worked.

## Worked example

User: `"I'm Alex, based in Amsterdam, frontend developer working mostly in React. I prefer concise replies — no preamble."`

You make four calls in parallel:

```
memory({ action: "add", target: "user", content: "Name: Alex" })
memory({ action: "add", target: "user", content: "Location: Amsterdam" })
memory({ action: "add", target: "user", content: "Role: frontend developer, primarily React" })
memory({ action: "add", target: "user", content: "Communication: concise replies, no preamble" })
```

Then you acknowledge in chat: `"got it, saved."`

Later, the user mentions: `"actually I switched to Vue last month."` You do not `add` a new entry — you `replace`:

```
memory({ action: "replace", target: "user", old_text: "React", content: "Role: frontend developer, primarily Vue (switched from React 2026-04)" })
```

## Banned patterns

- `write_file('/memory/USER.md', ...)` — filesystem mount is read-only, will fail
- `edit_file('/memory/MEMORY.md', ...)` — same
- Calling a `learn()` tool — does not exist
- Calling `memory_search` — does not exist (read your `<agent_memory>` block instead)
- Fabricating user attributes the user never stated (city, stack, age, role)
- `add`ing when the existing entry would now be wrong — always `replace`
