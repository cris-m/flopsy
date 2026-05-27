---
name: googlechat
description: Send and receive Google Chat messages using Google Chat's simple markdown (single-asterisk bold, underscore italic, backtick code). Covers length limits, allowed syntax, and Card v2 vs plain-text mode.
when-to-use: "Use when composing a reply on the Google Chat channel — covers Google Chat's lightweight markdown subset and 4 kB message cap."
category: channels
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# Google Chat

## Formatting (CRITICAL — Read BEFORE composing any message)

**STOP. Google Chat uses a minimal markdown subset.** Most standard markdown does not render. Tables and headers are NOT supported in plain-text messages.

### BANNED syntax (renders as literal text or breaks)
- **NO `# headers`** — hash characters show literal
- **NO `**double asterisks**`** — bold is `*single asterisks*`; doubles look literal
- **NO `[text](URL)` link syntax** — paste raw URLs; they auto-link
- **NO markdown tables** — pipes show as literal characters
- **NO `> blockquotes`** — greater-than shows literal
- **NO HTML tags** — `<b>`, `<i>` etc. render as literal text

### Supported formatting (Google Chat plain-text)
| Write this | Result |
|------------|--------|
| `*bold*` | **bold** (single asterisks) |
| `_italic_` | *italic* |
| `~strikethrough~` | ~strikethrough~ |
| `` `inline code` `` | inline code |
| ```` ```code block``` ```` | code block |
| `https://example.com` | auto-linked URL |
| `<users/USER_ID>` | user mention (must be the literal Google user ID) |

### Escape rules
Asterisks/underscores trigger formatting only when adjacent to non-whitespace. For literal:
- `foo*bar` — renders as literal (no closing wrapper)
- `foo _bar_ baz` — renders italic on `bar`
- Use code wrappers for anything you want literal: `` `foo*bar` ``

### Length & splitting
- Hard cap: **4,096 chars per message** (text-only mode)
- For richer formatting (headers, sections, buttons, key-value pairs) use **Card v2** — but that requires structured `cards: [...]` payload, NOT plain text markdown
- For multi-beat replies, use `send_message({parts: [...]})` to ship 2–3 paced messages

## Composition style

Google Chat is **work-context, defaults to bullets when summarizing**. Readers expect:
- Tight 1-line lead
- Bullets for any list (use `• ` or `- `)
- Blank lines between sections
- Code blocks for commands, paths, identifiers
- Source URL on its own line at the end

### Examples

**❌ BAD — markdown headers + literal asterisks:**
```
# Quantum AI

Quantum computing **uses qubits** that can exist in superpositions.

| Feature | Use |
|---------|-----|
| QSVM | Kernel methods |

See [docs](https://example.com)
```

**✅ GOOD — Google Chat plain-text mode:**
```
*Quantum AI — the gist:*

• Qubits can be in superposition (both 0 and 1)
• Quantum kernels speed up SVM-style classifiers
• Hybrid workflows keep most work on CPU/GPU

Docs: https://example.com
```

## Quirks
- Numbered lists `1.`, `2.` render as plain text — use bullets instead
- Markdown tables show as raw pipe-separated text — convert to bullets or use Card v2 with `keyValue` widgets
- Mentions require the Google user ID, not the display name — without it, `@username` renders as literal text
- DMs vs spaces (rooms) render identically; no special syntax needed
- Cards (Card v2) are a separate API surface — out of scope for plain-text `send_message`; if structured display is needed, route through the dedicated card-builder tool (not yet wired)
- Google Chat strips trailing whitespace and collapses multiple blank lines into one
