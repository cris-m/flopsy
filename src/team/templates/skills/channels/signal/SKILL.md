---
name: signal
description: Send and receive Signal messages. Signal is plain-text only — no markdown rendering. Covers length pacing and tone for secure-channel UX.
when-to-use: "Use when composing a reply on the Signal channel — covers Signal's plain-text-only rendering and secure-messaging tone conventions."
category: channels
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# Signal

## Formatting (CRITICAL — Read BEFORE composing any message)

**STOP. Signal renders ZERO markdown.** Anything you write between `*`, `_`, `**`, `#`, `[]()`, etc. shows as literal characters with the symbols visible.

### BANNED syntax (all rendered as literal text)
- **NO `*bold*` / `**bold**`** — asterisks show as literal asterisks
- **NO `_italic_`** — underscores show literal
- **NO `# headers`** — hash characters show literal
- **NO `[text](URL)`** — brackets + parens show literal; just paste the URL
- **NO `> quote`** — greater-than shows literal
- **NO `` `code` ``** / **``` ```code blocks``` ```** — backticks show literal
- **NO markdown tables** — pipes show literal

### What DOES work
- Plain text — every character renders literally as typed
- URLs (`https://...`) — auto-detected and tappable by Signal clients
- Emoji — render natively; useful for visual structure
- Line breaks — blank lines for paragraph separation
- ASCII bullets: `• ` or `- ` or `▸ ` render as the literal char (no styling, but visually clear)

### Length & splitting
- No hard cap in practice (Signal accepts very long messages)
- BUT Signal UX favors **short, tight messages**; readers expect SMS pacing
- Aim for ≤100 words / ≤6 lines per message
- For longer answers, use `send_message({parts: [...]})` to ship 2–3 paced messages

## Composition style

Signal is **secure messaging, terse, conversational, no fluff**. Treat it like a careful SMS:
- 1-line lead
- 2–4 short bullets (use `• ` or `- `)
- Blank lines between sections
- URL on its own line at the end (not inline)
- NO preamble like "Here is your answer:" — just answer
- Emoji ok for visual structure (e.g., `✅` for done, `⚠️` for warning)

### Examples

**❌ BAD — markdown that won't render + wall of text:**
```
**Quantum AI Overview**

Quantum computing uses qubits to explore many paths simultaneously. This enables certain problems—like *factoring*, unstructured search, and specific linear-algebra operations—to be solved with fewer steps than on classical computers.

See [more](https://example.com)
```

**✅ GOOD — Signal-native:**
```
Quantum computing — quick read:

• Qubits can be in superposition (both 0 and 1)
• Lets a quantum processor explore many paths at once
• Wins on factoring, search, some linear algebra

More: https://example.com
```

## Quirks
- Signal does NOT support inline media in text messages — attach via `media: [...]` on `send_message`
- Replies/quotes are a separate Signal feature — set `quoteUserMessage: true` on `send_message` to use it
- Read receipts and typing indicators are on by default in DMs
- Group messages: use `@displayname` for mentions (Signal clients render these as mention chips when the name matches a member)
- DO NOT include sensitive info in the message body that you wouldn't want screenshot-shared
