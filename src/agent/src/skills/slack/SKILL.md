---
name: slack
compatibility: Designed for FlopsyBot agent
description: Send and receive Slack messages using mrkdwn formatting. Includes formatting rules, thread awareness, delivery recovery, and component support.
---

# Slack

## Formatting (CRITICAL — Read BEFORE composing any message)

**STOP. Read these rules before writing ANY Slack message.**

### Slack uses mrkdwn, NOT standard Markdown

| Write this | Result |
|------------|--------|
| `*bold*` | **bold** |
| `_italic_` | *italic* |
| `~strikethrough~` | ~~strikethrough~~ |
| `` `code` `` | inline code |
| ```` ```code block``` ```` | code block |
| `>` quote | blockquote (single line) |
| `>>>` quote | blockquote (multi-line, everything after) |
| `<https://url\|display text>` | hyperlink |
| `<@USER_ID>` | user mention |
| `<#CHANNEL_ID>` | channel mention |
| `:emoji_name:` | Slack emoji |

### BANNED syntax (will NOT render correctly)
- **NO `**double asterisks**`** — use single `*bold*`
- **NO `[text](url)`** — use `<url|text>` format
- **NO `# headers`** — use `*Bold Section Title*` with emoji
- **NO `- bullet lists`** — use `•` or emoji bullets
- **NO `1. numbered lists`** — Slack doesn't render numbered markdown lists

### Message style
- Professional but approachable — Slack is a workspace tool
- Use emoji as section markers: :white_check_mark: :x: :warning: :bulb: :memo:
- Thread-aware: reply in threads when the conversation is ongoing
- Keep messages scannable — people skim in Slack
- Use `•` for bullet points
- Always include source links when sharing content — use `<url|source>` format

---

## When to Use This Skill

- User says "send a Slack message to ..."
- A message arrives on a Slack channel and needs a response
- User wants to post in a specific Slack channel or DM

## Threads

Slack is thread-heavy. Follow these rules:
- **Reply in-thread** when responding to a specific message (use `reply_to` with the message `ts`)
- **Post to channel** when starting a new topic or delivering proactive content
- **Use `reply_broadcast`** when a thread reply is important enough for the whole channel to see
- Never clutter the main channel with back-and-forth — use threads

## Recovery Chain

**On delivery failure:**

1. **Check formatting** — mrkdwn syntax errors (especially links) are the #1 cause
2. **Check link format** — must be `<url|text>`, NOT `[text](url)`
3. **Strip formatting** — resend as plain text if mrkdwn is causing issues
4. **Split message** — if over 40000 chars (unlikely), split at logical breaks
5. **Report failure** — ONLY after trying plain text

## Reactions

Slack supports **any emoji** for reactions — no restrictions unlike Telegram.

- Standard unicode emoji and custom workspace emoji both work
- Multiple reactions per message allowed
- Reactions are a key part of Slack culture — use them for acknowledgment (:eyes:, :thumbsup:), status (:white_check_mark:, :hourglass:), and expression

## Interactive Components

Slack supports Block Kit components (buttons, select menus) if the gateway tool exposes them:

### Buttons
```
send_message({
  channel: "slack", peer_id, peer_type,
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

### Select Menus
```
send_message({
  channel: "slack", peer_id, peer_type,
  message: "Choose environment:",
  components: [{
    components: [{
      type: "select_menu",
      placeholder: "Select environment",
      options: [
        { label: "Production", value: "prod" },
        { label: "Staging", value: "staging" },
        { label: "Development", value: "dev" }
      ]
    }]
  }]
})
```

## Guidelines

- Max message length: 40000 characters — but keep messages short for readability
- Code blocks: specify language for syntax highlighting
- Bot tokens and workspace config are managed by the gateway
- Always cite sources with links when presenting research: `<url|source name>`
- Respect workspace norms — Slack channels often have specific purposes
