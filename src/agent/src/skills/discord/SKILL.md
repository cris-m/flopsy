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

Use `send_message`'s `media` parameter to attach files:
```
send_message({
  channel: "discord", peer_id, peer_type,
  message: "Here's the chart",
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

Discord supports interactive buttons and native select menus via the `components` parameter on `send_message`. When a user clicks a button or selects an option, you receive their action as a regular text message — no special handling needed.

### Buttons

```
send_message({
  channel: "discord", peer_id, peer_type,
  message: "Deploy to production?",
  components: [{
    components: [
      { type: "button", label: "Deploy", style: "success" },
      { type: "button", label: "Cancel", style: "danger" }
    ]
  }]
})
```

When the user clicks "Deploy", you receive: `Clicked "Deploy".`

**Button styles:** `primary` (blurple, default), `secondary` (grey), `success` (green), `danger` (red), `link` (grey, opens URL — no interaction event)

**Mixed rows example** — callback buttons on row 1, link button on row 2:
```
send_message({
  channel: "discord", peer_id, peer_type,
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

```
send_message({
  channel: "discord", peer_id, peer_type,
  message: "Choose priority:",
  components: [{
    components: [{
      type: "select_menu",
      placeholder: "Select priority",
      options: [
        { label: "High", value: "high", description: "Urgent issues" },
        { label: "Medium", value: "medium" },
        { label: "Low", value: "low" }
      ]
    }]
  }]
})
```

When the user selects "High", you receive: `Selected "High" from "Select priority".`

### Component rules
- Each action row holds **up to 5 buttons** OR **1 select menu** (not both)
- A message can have **up to 5 action rows**
- Components expire after 30 minutes — expired clicks show "This button has expired."
- Components work on **Discord and Telegram** — other channels silently ignore them
- Components can be combined with text and media in the same message
- Link buttons open URLs directly (no interaction event back to you)

## Polls

Discord supports **native polls** via the `send_poll` tool. These render as interactive poll widgets in the channel — not plain text.

### Basic poll

```
send_poll({
  channel: "discord", peer_id, peer_type,
  question: "What should we work on next?",
  options: [
    { text: "Bug fixes" },
    { text: "New features" },
    { text: "Documentation" }
  ]
})
```

### With emoji

Discord poll options can include emoji:
```
send_poll({
  channel: "discord", peer_id, peer_type,
  question: "Pick a stack",
  options: [
    { text: "TypeScript", emoji: "🟦" },
    { text: "Python", emoji: "🐍" },
    { text: "Rust", emoji: "🦀" }
  ]
})
```

### Options

| Parameter | Default | Notes |
|-----------|---------|-------|
| `allow_multiple` | `false` | Allow selecting multiple options |
| `duration_hours` | `24` | Auto-close timer (1–768 hours) |

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
