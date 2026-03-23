---
name: imessage
compatibility: Designed for FlopsyBot agent
description: Send and receive iMessages and SMS via Apple Messages on macOS. Includes delivery failure recovery and recipient format validation.
---

# iMessage

## Formatting (CRITICAL — Read BEFORE composing any message)

**STOP. iMessage is PLAIN TEXT ONLY. NO markdown renders AT ALL.**

### BANNED — everything below shows as raw characters
- **NO `*asterisks*`** — shows literally as `*text*`
- **NO `**bold**`** — shows literally
- **NO `` `backticks` ``** — shows literally
- **NO `[links](url)`** — paste the raw URL
- **NO headers, lists, tables, code blocks** — none of it renders

### What to use instead
- Line breaks for paragraph separation
- Emoji are native and encouraged 🐰😊👍🔥✅
- Plain text only — clean, readable, no formatting syntax

### Message style
- Most personal channel — text like a close friend
- Very short messages — people read on phones
- Multiple short messages > one long wall of text
- Casual, warm, direct
- Emoji as visual markers instead of bullets (✅ ❌ 📌)
- When sharing links, paste the raw URL

---

## When to Use This Skill

- User says "text ..." or "send a message to ... via iMessage"
- A message arrives on the iMessage channel and needs a response
- User wants to check or reply to an iMessage conversation

## Recovery Chain

**On delivery failure:**

1. **Check recipient format** — iMessage requires either:
   - A valid phone number (international format preferred)
   - An Apple ID email address
   - A contact name that resolves to one of the above
2. **Check iMessage availability** — if recipient doesn't have iMessage, it falls back to SMS (green bubble). SMS may fail if the Mac doesn't have iPhone relay set up
3. **Check Messages app** — the macOS Messages app must be open and signed in
4. **Retry with phone number** — if sending by name fails, try the raw phone number
5. **Report failure** — ONLY after trying alternative recipient formats

## Platform Requirements

- macOS with Messages app open and running
- User signed into Apple ID in Messages
- Gateway's iMessage channel active and configured in `channels.yaml`
- For SMS fallback: iPhone with relay enabled or carrier-linked Mac

## Workflow

1. Identify the recipient by name or phone number
2. Look up the contact if needed
3. Compose the message as **plain text** — NO markdown
4. Send via the imessage channel tool
5. If delivery fails → check recipient format → try phone number → check Messages app

## Reactions

**iMessage reactions (Tapbacks) are NOT supported via the CLI integration.** The native Messages app supports 6 tapbacks (heart, thumbs up/down, laugh, exclamation, question mark) and full emoji reactions on iOS 18+, but these cannot be sent programmatically through the CLI.

**Ack reactions**: Not available on iMessage. If `ack_reaction` is configured globally, it will be silently skipped for iMessage.

**Workaround**: Send a short text reply (e.g., "👍") as an acknowledgment instead.

## Guidelines

- iMessage delivery depends on recipient being reachable (Apple ID or phone number)
- Green bubble = SMS fallback; may have different delivery characteristics
- Do not send sensitive information (passwords, tokens) via iMessage
- Group messages require all participants to be identified
- The local macOS Messages app must remain open for the integration to function
- Keep messages short — multiple short messages are better than one long one
