---
name: slack
description: Send and receive Slack messages using Slack mrkdwn (single-asterisk bold, <url|label> link syntax, channel/user mentions). Covers length limits, allowed syntax, and rendering quirks.
when-to-use: "Use when composing a reply on the Slack channel — covers Slack's mrkdwn dialect, link syntax, and mention format."
category: channels
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# Slack

## Formatting (CRITICAL — Read BEFORE composing any message)

**STOP. Slack uses "mrkdwn" — a near-markdown dialect with critical differences.** Standard markdown link syntax does NOT work.

### BANNED syntax (will render broken or as garbage)
- **NO `[text](URL)` link syntax** — Slack uses `<URL|text>` instead (angle brackets, pipe separator)
- **NO `**double asterisks**`** — bold is `*single asterisks*`; doubles look literal
- **NO `# headers`** — use `*Bold Header*` on its own line
- **NO markdown tables** — Slack ignores `|` table syntax entirely
- **NO `@username`** — mentions are `<@USERID>` (uppercase user ID, e.g. `<@U07XJK2A1B3>`)
- **NO `#channelname`** — channel refs are `<#CHANNELID>`

### Supported formatting (Slack mrkdwn)
| Write this | Result |
|------------|--------|
| `*bold*` | **bold** (single asterisks) |
| `_italic_` | *italic* |
| `~strikethrough~` | ~strikethrough~ |
| `` `inline code` `` | inline code |
| ```` ```code block``` ```` | code block |
| `> quoted line` | blockquote (single-line prefix per line) |
| `<https://example.com>` | auto-linked URL |
| `<https://example.com\|My Site>` | URL with label |
| `<@U07XJK2A1B3>` | user mention |
| `<#C01ABCDE2F3>` | channel reference |
| `<!here>`, `<!channel>` | special mentions (use sparingly) |

### Escape rules
Slack auto-converts `&`, `<`, `>` in plain text to HTML entities. For literal angle brackets that aren't link syntax:
- `<` → write `&lt;`
- `>` → write `&gt;` (but `>` at line start is a blockquote prefix — that one works as-is)
- `&` → write `&amp;`

Code blocks (`` ` `` and ``` ``` ```) suppress all formatting inside.

### Length & splitting
- Hard cap: **40,000 chars per message** (Block Kit sections cap at 4,000 each)
- Slack threads are a first-class feature — replies > 200 words should consider going into a thread (`thread_ts` parameter, currently not surfaced via send_message)
- For multi-beat replies, use `send_message({parts: [...]})` to ship 2–3 paced messages

## Composition style

Slack is **work-context, threaded, terse**. Readers expect:
- Short tight lead
- 2–4 bullets if multiple points; otherwise a tight paragraph
- Code blocks for any command/path/identifier (Slack renders these beautifully)
- Links with labels: `<https://api.example.com|API docs>` reads better than raw URLs
- Single `*bold*` for key terms; no overuse

### Examples

**❌ BAD — broken link syntax + bullets without spacing:**
```
**Quantum AI**
- Used for ML kernels
- See [docs](https://example.com)
```

**✅ GOOD — Slack-native:**
```
*Quantum AI — the gist:*

• Quantum kernels speed up SVM-style classifiers
• Hybrid workflows keep most work on CPU/GPU, offload sampling to QPU
• Frameworks: Qiskit, Cirq, PennyLane

Docs: <https://example.com|Quantum AI overview>
```

## Quirks
- `*foo*` requires NON-letter chars on the outside to render bold — `(*foo*)` works, `a*foo*b` does not
- Numbered lists `1.`, `2.` render as plain text — use bullets instead
- Code blocks have a 25-line preview limit before "Show more" — keep them concise
- DMs vs channels render identically; no special syntax needed
- Slack's "Send as Reply" feature is separate from message body — use `quoteUserMessage: true` on `send_message` if you want to thread to the user's last message
