---
name: discord
compatibility: Designed for FlopsyBot agent
description: Send and receive Discord messages with extended Markdown formatting. Includes 2000-character limit enforcement, auto-chunking strategy, and delivery recovery.
---

# Discord

## Formatting (CRITICAL — Read BEFORE composing any message)

**STOP. Check message length BEFORE sending. Discord REJECTS messages over 2000 characters.**

### Message length rules
- **Max 2000 characters per message** — the API silently rejects longer messages
- **If content exceeds 2000 chars**: split into multiple messages at logical break points (paragraphs, sections)
- **For code output**: use thread replies to keep channels clean
- **For very long content**: consider using an embed or file attachment if the tool supports it

### Supported formatting (full GitHub-flavored Markdown)
| Write this | Result |
|------------|--------|
| `**bold**` | **bold** |
| `*italic*` or `_italic_` | *italic* |
| `***bold italic***` | ***bold italic*** |
| `~~strikethrough~~` | ~~strikethrough~~ |
| `` `inline code` `` | `inline code` |
| ```` ```language ... ``` ```` | syntax-highlighted code block |
| `> quote` | blockquote |
| `[text](URL)` | hyperlink |
| `- item` | bullet list |
| `1. item` | numbered list |
| `## Heading` | heading (H1-H3) |
| `<@user_id>` | user mention |
| `<#channel_id>` | channel mention |
| `:emoji_name:` | Discord emoji |

### Images, audio, video, and files
**Discord does NOT render markdown images.** `![alt](url)` shows as raw text.

Use `send_message`'s `media` parameter to attach files. Channel + peer come from the runtime context; you only pass `text` / `buttons` / `media`:
```
send_message({
  text: "Here's the chart",
  media: [{ type: "image", url: "/scratch/chart.png" }]
})
```
Verify the file exists before sending. Never use `![alt](url)` syntax on Discord.

### Message style
- Discord is the most flexible channel — use its full formatting power
- Use `##` headers to organize longer responses
- Use `-` bullet lists freely
- Emoji via `:name:` syntax or unicode: 🐰 ✅ ❌ 🔥 💡
- Casual, community-oriented tone
- Use `> quotes` for referencing
- Code blocks with syntax highlighting for technical content
- Always include source links when sharing content
- For long outputs, use threads to keep channels clean

---

## When to Use This Skill

- User says "post in Discord" or "send a Discord message"
- A message arrives on a Discord channel and needs a response
- User wants to check or browse Discord conversations

## Recovery Chain

**On delivery failure:**

1. **Check message length** — if over 2000 chars, split into multiple messages
2. **Chunking strategy**: split at paragraph breaks, section headers, or after every 1800 chars (leave buffer)
3. **For code blocks exceeding 2000 chars**: split the code into logical chunks, each in its own code block
4. **Thread fallback**: if the channel doesn't allow multiple messages, use thread replies
5. **Report failure** — ONLY after trying chunked delivery

## Workflow

1. Identify the target channel (name or ID)
2. Compose the message using Discord Markdown
3. **Check length** — if over 2000 chars, split into chunks
4. Send via the discord channel tool
5. If delivery fails → check length → split → retry in thread

## Interactive Components (Buttons & Select Menus)

Discord supports interactive buttons via the top-level `buttons` array on `send_message`. When a user clicks a button, you receive its `value` as a regular text message — no special handling needed.

### Buttons

Each button needs a `label` (shown to the user), a `value` (what comes back when tapped — required), and optionally a `style`. Discord renders style colours; other channels ignore the field.

```
send_message({
  text: "Deploy to production?",
  buttons: [
    { label: "Deploy", value: "deploy", style: "success" },
    { label: "Cancel", value: "cancel", style: "danger" }
  ]
})
```

When the user clicks "Deploy", you receive a message with content `deploy`.

**Button styles:** `primary` (blurple, default), `secondary` (grey), `success` (green), `danger` (red). Discord-only — Telegram ignores the style field.

**Limit:** max 9 buttons per message. For more options or aggregated voting use `send_poll`.

### Button rules
- Each button needs both `label` (display) and `value` (what comes back on click — required)
- Buttons work on **Discord and Telegram**; other channels silently drop them
- Buttons can be combined with `text` and `media` in the same message
- Discord renders the `style` colour; Telegram ignores it

## Polls

Discord supports **native polls** via the `send_poll` tool. These render as interactive poll widgets in the channel — not plain text.

### Basic poll

```
send_poll({
  question: "What should we work on next?",
  options: ["Bug fixes", "New features", "Documentation"]
})
```

The `options` array takes plain strings. Inline emoji in the option text renders naturally on Discord:

```
send_poll({
  question: "Pick a stack",
  options: ["🟦 TypeScript", "🐍 Python", "🦀 Rust"]
})
```

### Options

| Parameter | Default | Notes |
|-----------|---------|-------|
| `anonymous` | `false` | Set true to hide voter identities (you lose per-user signal) |
| `allowMultiple` | `false` | Allow selecting multiple options |
| `durationHours` | `24` | Auto-close timer (Discord: 1–768h. Telegram caps at ~10 min). |

### Vote tracking
When a user votes on a Discord poll, you receive a message: `Voted "Option text" in a poll.`
Users also see real-time vote counts in the Discord UI natively.

### Limits
- Question: max 300 characters
- Options: 2–10 choices, each max 100 characters
- Duration: 1–768 hours (default 24h)

## Reactions

Discord supports reacting with **any unicode emoji** plus **custom server emoji** — no restrictions.

Reactions are a huge part of Discord culture. Use them naturally — in busy servers, a reaction can be better than a full reply (less noise, same energy).

- **Custom server emoji**: `<:name:id>` format — must be in the server that owns them
- Custom emoji slots: 50+50 (base) up to 250+250 (boosted)
- Super Reactions are Nitro-only, not available to bots

## Guidelines

- Discord renders Markdown automatically; no need to escape most characters
- Mentions use `<@user_id>` syntax, not plain usernames
- Embeds (rich cards) are supported if the tool exposes them
- The gateway manages bot token and permissions
- **Always check message length before sending** — this is the most common Discord failure
- Cite sources with links when presenting research or curated content
