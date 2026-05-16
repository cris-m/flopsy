---
name: telegram
compatibility: Designed for FlopsyBot agent
description: Send and receive Telegram messages using MarkdownV2 formatting. Includes strict formatting rules, escape character reference, and delivery failure recovery.
---

# Telegram

## Formatting (CRITICAL — Read BEFORE composing any message)

**STOP. Read these rules before writing ANY Telegram message.**

### BANNED syntax (will break the message or render as garbage)
- **NO `# headers`** — use `*bold text*` or emoji headers instead (e.g., `📊 *Section Title*`)
- **NO `**double asterisks**`** — use single `*bold*`
- **NO markdown tables** — use aligned text with emoji or plain columns
- **NO `> blockquotes`** — not supported in MarkdownV2
- **NO `- bullet lists`** — use emoji bullets: `▸`, `•`, `✅`, `❌`

### Supported formatting
| Write this | Result |
|------------|--------|
| `*bold*` | **bold** |
| `_italic_` | *italic* |
| `__underline__` | underline |
| `~strikethrough~` | strikethrough |
| `` `code` `` | inline code |
| ```` ```code block``` ```` | code block |
| `[text](URL)` | hyperlink |
| `[text](tg://user?id=123)` | mention by ID |

### Escape ALL these characters in plain text
```
_ * [ ] ( ) ~ ` > # + - = | { } . !
```
Every one of these MUST be escaped with `\` when used as literal text:
- Periods: `Hello world\.` ← escape the period
- Parentheses: `\(optional\)` ← both must be escaped
- Hyphens: `re\-run` ← must be escaped
- Exclamation: `wow\!` ← must be escaped

**If a message fails to send, the #1 cause is unescaped special characters.** Check escaping first.

### Message style
- Semi-casual tone, emoji expected and natural
- Use emoji as section markers: 📊 📬 🗓️ 🔔 ✅ ❌
- Short, scannable messages — people read Telegram on phones
- Break long content into multiple short messages or use emoji bullets
- Use 🐰 as signature when it feels right
- Always include source links when sharing content — use `[source](URL)` format

---

## When to Use This Skill

- User says "send a Telegram message to ..."
- A message arrives on the Telegram channel and needs a response
- User wants to check or browse Telegram conversations

## Recovery Chain

**On delivery failure:**

1. **Check escaping** — the #1 cause of Telegram message failures is unescaped MarkdownV2 characters
2. **Strip formatting** — resend as plain text (remove all `*`, `_`, `~`, etc.) if escaping fix doesn't work
3. **Split message** — if message is too long, break into chunks under 4096 characters
4. **Report failure** — ONLY after trying plain text. State the error

## Workflow

1. Identify the recipient (Telegram user, chat ID, or group)
2. Compose the message — **apply MarkdownV2 rules from above**
3. Escape ALL special characters in plain text portions
4. Send via the telegram channel tool
5. If delivery fails → check escaping → retry as plain text → split if too long

## Reactions

Telegram bot reactions are **limited to 73 specific emoji** — NOT the full keyboard. Using an unsupported emoji will silently fail.

Use reactions to keep the conversation warm and human — sometimes a reaction says everything.

**Allowed emoji (ONLY these 73 work):**
👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤️‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

**Limitations:**
- 1 reaction per message (bots)
- **Cannot react in DMs** — Telegram privacy restriction, only groups/channels
- 🐰 is NOT in the list

## Polls

Telegram supports **native polls** via the `send_poll` tool. These render as interactive poll widgets — not plain text.

### Basic poll

`send_poll` takes a flat schema — channel + peer come from the runtime context, not the args:

```
send_poll({
  question: "What should we work on next?",
  options: ["Bug fixes", "New features", "Documentation"]
})
```

### Vote tracking

Polls are **non-anonymous by default** (`anonymous: false`). When a user votes, you receive a message:
- Single vote: `Voted option 2 in a poll.`
- Multi-select: `Voted options 1, 3 in a poll.`
- Vote retraction: no message (silent)

Set `anonymous: true` to disable vote tracking (you won't receive vote messages).

### Options

| Parameter | Default | Notes |
|-----------|---------|-------|
| `anonymous` | `false` | Set `true` to hide voter identity (disables vote tracking) |
| `allowMultiple` | `false` | Allow selecting multiple options |
| `durationHours` | none | Auto-close timer. Telegram max is ~0.17h (600 seconds) |

### Limits
- Question: max 300 characters
- Options: 2–10 choices, each max 100 characters

## Interactive Buttons

Telegram supports inline keyboard buttons via the top-level `buttons` array on `send_message`. When the user taps a button you receive its `value` as a synthetic user message — no special handling needed.

```
send_message({
  text: "Deploy to production?",
  buttons: [
    { label: "Deploy", value: "deploy" },
    { label: "Cancel", value: "cancel" }
  ]
})
```

Each button needs a `label` (shown to the user) and a `value` (returned on tap — required). The optional `style` field (`primary` / `secondary` / `success` / `danger`) is Discord-only; Telegram renders all inline buttons in its single neutral style.

**Limit:** max 9 buttons per message. For aggregated multi-choice voting use `send_poll`.

## Guidelines

- Always escape special characters; unescaped characters cause the API to reject the message
- For code blocks, specify language: ```` ```python ... ``` ````
- Bot tokens and chat IDs are managed by the gateway configuration
- Max message length: 4096 characters — split longer content
- Always cite sources with links when presenting research or news content
