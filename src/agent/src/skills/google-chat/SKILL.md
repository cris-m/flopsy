---
name: google-chat
compatibility: Designed for FlopsyBot agent
description: Send and receive Google Chat messages with basic formatting. Includes space/DM awareness, formatting limitations, and delivery recovery.
---

# Google Chat

## Formatting

Google Chat supports basic text formatting:

| Write this | Result |
|------------|--------|
| `*bold*` | **bold** |
| `_italic_` | *italic* |
| `~strikethrough~` | ~~strikethrough~~ |
| `` `code` `` | inline code |
| ```` ```code block``` ```` | code block |

### NOT supported
- **NO inline links** — paste full URLs, they auto-link
- **NO headers** — use `*Bold Text*` for section titles
- **NO bullet lists** — use `•` or `▸` manually
- **NO blockquotes** — not supported
- **NO images/media via API** — text only

### Message style
- Professional and workspace-appropriate — this is Google Workspace
- Concise — Google Chat is often used for quick coordination
- Use `•` for bullet points
- Full URLs auto-link — no special syntax needed
- Emoji are supported via unicode

---

## When to Use This Skill

- User says "send a Google Chat message to ..."
- A message arrives from a Google Chat space and needs a response
- User wants to post in a Google Chat space or DM

## Terminology

Google Chat uses specific terminology:
- **Space** = a chat room (equivalent to Slack channel or Discord server channel)
- **DM** = direct message between two people
- **Thread** = a reply chain within a space
- Do NOT say "channel" or "group" — say "space"

## Limitations

- **No typing indicators** — Google Chat API does not support them
- **No reactions** — emoji reactions are not available via the API
- **No buttons/components** — no interactive elements via API
- **No polls** — not supported
- **No media attachments** — text-only via the Chat API
- **No message editing** — once sent, messages cannot be edited via API

## Recovery Chain

**On delivery failure:**

1. **Check authentication** — service account token may have expired
2. **Check space access** — bot must be added to the space
3. **Strip formatting** — resend as plain text if formatting causes issues
4. **Report failure** — ONLY after trying plain text

## Guidelines

- Keep messages brief — Google Chat is a lightweight communication tool
- Paste URLs directly (they auto-link) instead of trying to format links
- The bot must be explicitly added to a space to send/receive messages
- Service account credentials are managed by the gateway configuration
- For long content, break into multiple messages at paragraph boundaries
