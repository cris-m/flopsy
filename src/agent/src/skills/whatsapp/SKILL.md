---
name: whatsapp
compatibility: Designed for FlopsyBot agent
description: Send and receive WhatsApp messages with limited formatting. Includes session expiry detection, reconnect workflow, and delivery failure recovery.
---

# WhatsApp

## Formatting (CRITICAL — Read BEFORE composing any message)

**STOP. WhatsApp has VERY limited formatting. Most Markdown will render as raw text.**

### Supported formatting (ONLY these work)
| Write this | Result |
|------------|--------|
| `*bold*` | **bold** |
| `_italic_` | *italic* |
| `~strikethrough~` | ~~strikethrough~~ |
| `` `code` `` | inline code |
| ```` ```code block``` ```` | code block |

### BANNED syntax (renders as literal text — looks broken)
- **NO `**double asterisks**`** — use single `*bold*`
- **NO `[links](url)`** — paste the raw URL directly
- **NO `# headers`** — use `*bold*` text or emoji markers instead
- **NO `- bullet lists`** — use emoji bullets: `▸`, `•`, `✅`, `❌`, or numbered lists
- **NO `> blockquotes`**
- **NO tables**

### Message style
- Casual — talk like texting a friend
- Emoji freely 🐰✅❌📋🔥💡⚡
- Short paragraphs, lots of line breaks
- Use emoji as bullet points: ✅ Done, ❌ Failed, 📌 Important
- Keep responses under 500 words unless asked for detail
- No headers, no structure — flowing text with emoji markers
- When sharing links, paste the raw URL (no markdown link syntax)

---

## When to Use This Skill

- User says "send a WhatsApp message to ..."
- User wants to check or reply to WhatsApp conversations
- A message arrives on the WhatsApp channel and needs a response

## Recovery Chain

**On delivery failure:**

1. **Check session** — WhatsApp sessions expire. Verify session is active:
   ```
   Check if session file exists at ~/.flopsy/sessions/whatsapp
   ```
2. **Reconnect via gateway** — if session expired, trigger reconnect through the gateway's WhatsApp channel
3. **Check formatting** — strip all formatting and resend as plain text
4. **Check recipient** — verify the phone number format (international format with country code, no spaces)
5. **Report failure** — ONLY after trying reconnect + plain text

## Session Management

WhatsApp uses a persistent session stored at `~/.flopsy/sessions/whatsapp`.

**Session expiry signs:**
- Messages fail to send with connection/session errors
- Gateway logs show "session disconnected" or "not authenticated"

**Recovery:**
1. Check session file exists
2. Trigger gateway reconnect (the gateway handles QR code re-scanning)
3. If reconnect fails, inform user they need to re-scan the QR code via the gateway setup

## Workflow

1. Identify the recipient (contact name or phone number in international format)
2. Look up the contact if needed (check Google Contacts or device address book)
3. Compose the message — **apply WhatsApp formatting rules from above**
4. Send via the whatsapp channel tool
5. If delivery fails → check session → reconnect → retry as plain text

## Reactions

WhatsApp supports reacting with **any emoji** (full keyboard — 3600+). No restrictions.

Use reactions to keep the conversation warm and human — react the way a real friend would. Sometimes a reaction is the perfect reply on its own, no message needed.

- One reaction per message per user (new replaces old)
- Send empty emoji or `remove: true` to remove a reaction

## Guidelines

- Always confirm the recipient before sending, especially for phone numbers
- Phone numbers must be in international format (e.g., +1234567890)
- For group messages, the group identifier must be known ahead of time
- Media (images, files) support depends on gateway configuration
- Rate limits apply; do not spam messages in rapid succession
- When sharing links, paste them directly — no markdown link syntax
