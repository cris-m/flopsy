---
name: whatsapp
description: Send and receive WhatsApp messages using WhatsApp's lightweight formatting (single-asterisk bold, underscore italic, blockquote). Covers length limits, allowed syntax, and rendering quirks.
when-to-use: "Use when composing a reply on the WhatsApp channel — covers WhatsApp's formatting and the chars that need to be escaped for clean rendering."
category: channels
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# WhatsApp

## Formatting (CRITICAL — Read BEFORE composing any message)

**STOP. WhatsApp is NOT Markdown.** It has its own minimal formatting based on single-char wrappers. Most markdown syntax does nothing or renders as literal symbols.

### BANNED syntax (renders as garbage or invisible)
- **NO `# headers`** — they render as literal `#` characters with no styling
- **NO `**double asterisks**`** — bold is `*single asterisks*`; doubles look like literal asterisks
- **NO `[text](URL)` link syntax** — paste raw URLs; they auto-link
- **NO markdown tables** — use aligned text or bullet lists
- **NO `### subheaders`** — use `*Bold Section*` on its own line

### Supported formatting (WhatsApp-native)
| Write this | Result |
|------------|--------|
| `*bold*` | **bold** (single asterisks) |
| `_italic_` | *italic* |
| `~strikethrough~` | ~strikethrough~ |
| `` `code` `` | inline code |
| ```` ```code block``` ```` | code block |
| `> quoted text` | blockquote (WhatsApp Sept 2024+) |
| `- bullet` or `* bullet` | bullet list (plain text — WhatsApp renders as plain) |
| `https://example.com` | auto-linked |

### Escape rules
WhatsApp's formatting only triggers when wrappers appear word-adjacent. To use literal asterisk/underscore in text, put a space on both sides or escape with backslash inside code:
- `width * height` → renders literally (spaces both sides)
- `foo_bar` → renders as `foo`(italic open)`bar` — break with space or use code: `` `foo_bar` ``
- Inside `` `code` `` or ``` ```code blocks``` ```, nothing is interpreted

### Length & splitting
- Hard cap: **65,536 bytes** per message (effectively unlimited for chat)
- BUT readers skim on mobile — aim for ≤150 words / ≤8 short lines
- For replies with distinct beats (lead → bullets → source), use `send_message({parts: [...]})` to ship 2–3 paced messages

## Composition style

WhatsApp UX is **mobile-first, conversational, terse**. Treat it like SMS:
- 1–2 sentence lead
- Bullets for any list (use `- ` or `• `)
- Blank lines between sections
- Source URL on its own line at the end
- NO essay-style paragraphs

### Examples

**❌ BAD — wall of text + broken syntax:**
```
**Quantum Computing Overview**
- Item one
- Item two
[Read more](https://example.com)
```

**✅ GOOD — WhatsApp-native:**
```
*Quantum computing — quick read:*

• Qubits can be in superposition (both 0 and 1)
• Lets you explore many computational paths at once
• Good for factoring, search, some linear algebra

Source: https://example.com
```

## Quirks
- Asterisks inside a URL break formatting — keep URLs on their own line
- Emoji render natively and contribute to mobile readability
- Forward markers (`> Forwarded message`) are added by WhatsApp, not us — don't manually prefix
- Voice notes and media should be attached as `media: [...]` on `send_message`, not described in text
