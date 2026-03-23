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

```
send_poll({
  channel: "telegram", peer_id, peer_type,
  question: "What should we work on next?",
  options: [
    { text: "Bug fixes" },
    { text: "New features" },
    { text: "Documentation" }
  ]
})
```

### Vote tracking

Polls are **non-anonymous by default** (`anonymous: false`). When a user votes, you receive a message:
- Single vote: `Voted option 2 in a poll.`
- Multi-select: `Voted options 1, 3 in a poll.`
- Vote retraction: no message (silent)

Set `anonymous: true` to disable vote tracking (you won't receive vote messages).

### Quiz mode

Telegram supports quiz polls — one correct answer, wrong answers show an X:
```
send_poll({
  channel: "telegram", peer_id, peer_type,
  question: "What is the capital of France?",
  options: [
    { text: "London" },
    { text: "Paris" },
    { text: "Berlin" }
  ],
  anonymous: false,
  is_quiz: true,
  correct_option_index: 1
})
```
`correct_option_index` is 0-based (Paris = index 1).

### Options

| Parameter | Default | Notes |
|-----------|---------|-------|
| `allow_multiple` | `false` | Allow selecting multiple options |
| `duration_hours` | none | Auto-close timer. Telegram max is ~0.17h (600 seconds) |
| `anonymous` | `false` | Set `true` to hide voter identity (disables vote tracking) |

### Limits
- Question: max 300 characters
- Options: 2–10 choices, each max 100 characters
- `duration_hours` is converted to seconds and capped at 600s by Telegram

## Interactive Components (Buttons & Select Menus)

Telegram supports inline keyboard buttons and select menus via the `components` parameter on `send_message`. Select menus are rendered as rows of buttons (Telegram has no native dropdown widget).

### Buttons

```
send_message({
  channel: "telegram", peer_id, peer_type,
  message: "Deploy to production?",
  components: [{
    components: [
      { type: "button", label: "Deploy", style: "success" },
      { type: "button", label: "Cancel", style: "danger" }
    ]
  }]
})
```

When the user taps "Deploy", you receive: `Clicked "Deploy".`

**Button styles:** `primary` (blue), `secondary` (grey), `success` (green), `danger` (red), `link` (URL — no interaction event)

**Mixed rows example** — callback buttons on row 1, link button on row 2:
```
send_message({
  channel: "telegram", peer_id, peer_type,
  message: "Review the deployment request:",
  components: [
    {
      components: [
        { type: "button", label: "Approve", style: "success" },
        { type: "button", label: "Reject",  style: "danger"  },
        { type: "button", label: "Deploy",  style: "primary" }
      ]
    },
    {
      components: [
        { type: "button", label: "Documentation", style: "link", url: "https://example.com/docs" }
      ]
    }
  ]
})
```

**Link button** (opens a URL, no click event):
```
{ type: "button", label: "View Docs", style: "link", url: "https://example.com" }
```

### Select Menus

Select menus are flattened into button rows on Telegram (no native dropdown):
```
send_message({
  channel: "telegram", peer_id, peer_type,
  message: "Choose priority:",
  components: [{
    components: [{
      type: "select_menu",
      placeholder: "Select priority",
      options: [
        { label: "High", value: "high" },
        { label: "Medium", value: "medium" },
        { label: "Low", value: "low" }
      ]
    }]
  }]
})
```

When the user selects "High", you receive: `Selected "High" from "Select priority".`

### Component rules
- Each action row can hold **multiple buttons** (Telegram renders up to ~8 per row)
- A message can have **multiple action rows**
- Select menus are flattened into button rows — Telegram has no native dropdown
- Components expire after 30 minutes — expired taps show "This button has expired."
- Components work on **Telegram and Discord** — other channels silently ignore them
- Components can be combined with text in the same message
- Link buttons open URLs directly (no interaction event back to you)

## Guidelines

- Always escape special characters; unescaped characters cause the API to reject the message
- For code blocks, specify language: ```` ```python ... ``` ````
- Bot tokens and chat IDs are managed by the gateway configuration
- Max message length: 4096 characters — split longer content
- Always cite sources with links when presenting research or news content
