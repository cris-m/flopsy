---
name: signal
compatibility: Designed for FlopsyBot agent
description: Send and receive Signal messages with end-to-end encryption. Includes session expiry recovery, re-link instructions, and delivery failure handling.
---

# Signal

## Formatting (CRITICAL — Read BEFORE composing any message)

**STOP. Signal is PLAIN TEXT ONLY. NO markdown renders.**

### BANNED — all formatting shows as raw characters
- **NO `*asterisks*`** — shows literally
- **NO `**bold**`** — shows literally
- **NO `` `backticks` ``** — shows literally
- **NO headers, lists, tables, code blocks** — none of it renders

### What to use instead
- Line breaks for separation
- Emoji are supported: ✅ ❌ 📌
- Plain text only — clean and readable
- When sharing links, paste the raw URL

### Message style
- Signal users are privacy-conscious — keep tone direct and efficient
- Short, clear messages — no unnecessary fluff
- Emoji are fine but purposeful: ✅ Done, ❌ Issue, 📌 Note
- Use 🐰 sparingly — match the user's energy

---

## When to Use This Skill

- User says "send a Signal message to ..." or "message via Signal"
- A message arrives on the Signal channel and needs a response
- User wants to check or browse Signal conversations

## Recovery Chain

**On delivery failure:**

1. **Check session** — Signal sessions can expire or become invalid:
   ```
   Check if session file exists at ~/.flopsy/sessions/signal
   ```
2. **Re-link device** — if session is expired/invalid:
   - The gateway needs to re-register with Signal
   - Inform user: "Your Signal session has expired. Please re-link through the gateway setup."
   - The gateway handles the QR code / phone number verification flow
3. **Check recipient** — verify phone number is in international format (+1234567890)
4. **Retry as plain text** — strip any accidental formatting
5. **Report failure** — ONLY after trying re-link + recipient check

## Session Management

Signal sessions are persistent and stored at `~/.flopsy/sessions/signal`. Signal requires a linked phone number and device registration.

**Session expiry signs:**
- Messages fail with connection/registration errors
- Gateway logs show "session expired" or "not registered"
- Sending returns "device not linked"

**Recovery:**
1. Check if session file exists at `~/.flopsy/sessions/signal`
2. If missing or corrupt → user must re-link through gateway setup
3. If present but errors persist → delete session and re-link
4. The gateway handles the Signal verification flow (phone number + verification code)

## Security and Privacy

- All Signal messages are end-to-end encrypted — the gateway integration does not weaken this
- Do NOT log or store Signal message content beyond the immediate session
- Respect disappearing messages settings — if enabled, content auto-deletes
- Signal does not support delivery receipts in all configurations

## Workflow

1. Identify the recipient by phone number (international format) or Signal contact name
2. Compose the message as **plain text** — NO markdown
3. Send via the signal channel tool
4. If delivery fails → check session → re-link if needed → verify recipient format

## Reactions

Signal supports reacting with **any emoji** — full unicode keyboard, no restrictions.

Use reactions naturally to keep conversations warm. Works in both DMs and group chats.

- Send empty emoji or `remove: true` to remove a reaction

## Guidelines

- Signal requires a valid phone number for the recipient
- Group messaging is supported; group ID from invite link or existing conversation
- Media (images, files) support depends on gateway configuration
- Periodic re-authentication may be required — the session is not permanent
- Always prioritize the user's privacy — don't expose message content in logs
