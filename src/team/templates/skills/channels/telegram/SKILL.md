---
name: telegram
description: Send and receive Telegram messages. The gateway converts standard Markdown to Telegram formatting automatically — write plain Markdown, never escape. Covers reactions, polls, buttons, and length limits.
when-to-use: "Use when composing a reply on the Telegram channel — covers formatting (auto-handled by the gateway), reactions, polls, buttons, and length limits."
category: channels
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# Telegram

## Formatting

Write **normal, standard Markdown**. The gateway converts it to valid Telegram markup for you — you do NOT need to escape characters and you do NOT need to know Telegram's MarkdownV2 rules. Just write clean Markdown the way you would anywhere.

### Write it the standard way
| Write this | Renders as |
|------------|-----------|
| `**bold**` | bold |
| `*italic*` or `_italic_` | italic |
| `~~strikethrough~~` | strikethrough |
| `` `inline code` `` | inline code |
| ```` ```lang … ``` ```` | code block (keep the language label) |
| `[text](https://url)` | link |
| `# Heading` | bold line (Telegram has no headings) |
| `> quote` | blockquote |
| `- item` / `* item` | bullet (•) |
| `\|\|secret\|\|` | spoiler |

### Don't
- **Don't escape characters.** Write `Hello world.`, `re-run`, `wow!`, `(optional)` exactly as normal prose. Pre-escaping (`\.`, `re\-run`) now produces VISIBLE backslashes — the converter already handles `< > &` and entity safety.
- **Don't hand-write MarkdownV2 or HTML.** No `\(`, no `<b>` tags. Plain Markdown only.
- **Tables aren't supported** by Telegram — use aligned text or emoji columns.

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

Formatting and escaping are handled by the gateway (standard Markdown → Telegram HTML, with an automatic plain-text fallback if anything fails to parse), so there is nothing for you to escape or fix. If a send still genuinely fails:

1. **Too long?** — keep messages focused; content over 4096 characters is auto-split, but shorter is better on mobile.
2. **Report failure** — only after a real delivery error. State the error verbatim.

## Workflow

1. Identify the recipient (Telegram user, chat ID, or group)
2. Compose the message in plain, standard Markdown
3. Send via the telegram channel tool — the gateway converts and delivers it

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
- Buttons stay clickable as long as the message exists — Telegram has no server-side expiry. A tap only fails if the gateway restarted and lost the in-memory callback handler.
- Components work on **Telegram and Discord** — other channels silently ignore them
- Components can be combined with text in the same message
- Link buttons open URLs directly (no interaction event back to you)

## Guidelines

- Write standard Markdown; the gateway handles Telegram escaping/conversion. Never escape characters yourself.
- For code blocks, specify language: ```` ```python ... ``` ````
- Bot tokens and chat IDs are managed by the gateway configuration
- Max message length: 4096 characters — split longer content
- Always cite sources with links when presenting research or news content
