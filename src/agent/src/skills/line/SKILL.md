---
name: line
compatibility: Designed for FlopsyBot agent
description: Send and receive LINE messages with sticker support. Includes delivery failure recovery and message type handling for text, stickers, images, and location.
---

# LINE

## Formatting (CRITICAL — Read BEFORE composing any message)

**STOP. LINE text messages are PLAIN TEXT ONLY. NO markdown renders.**

### BANNED — formatting shows as raw characters
- **NO `*asterisks*`** — shows literally
- **NO `**bold**`** — shows literally
- **NO `[links](url)`** — paste the raw URL
- **NO headers, lists, tables, code blocks** — none of it renders

### What to use instead
- Plain text with emoji — emoji and stickers are LINE's core expression
- LINE stickers are MORE expressive than emoji — use them when available
- Short, friendly messages
- When sharing links, paste the raw URL

### Message types (LINE supports more than just text)
- **Text**: plain text with emoji
- **Stickers**: LINE-native sticker packs (requires `packageId` + `stickerId`)
- **Images/Video/Audio**: binary media attachments
- **Location**: structured with coordinates (title, address, lat, lng)

### Message style
- LINE is Japan/Asia-focused — stickers are a core part of communication
- Emoji very natural and expected 🐰✨😊
- Stickers are even more common than emoji
- Keep messages short and friendly
- Multiple short messages preferred over long blocks
- Casual, warm tone

---

## When to Use This Skill

- User says "send a LINE message to ..." or "message someone on LINE"
- A message arrives on the LINE channel and needs a response
- User wants to check or browse LINE conversations

## Recovery Chain

**On delivery failure:**

1. **Check recipient ID** — LINE uses internal user IDs and group IDs, not phone numbers:
   - User/group IDs come from the gateway (incoming message context)
   - For new outbound messages, the user ID must be known ahead of time
2. **Check message type** — ensure the message type matches the content:
   - Text message with sticker fields → split into separate text + sticker messages
   - Media without proper binary → check the file path/URL
3. **Check rate limits** — LINE has per-channel rate limits:
   - If rate limited, wait 1 minute then retry once
   - Do NOT retry in a loop
4. **Check bot token** — verify the LINE bot token in gateway configuration is valid
5. **Report failure** — ONLY after checking recipient, type, rate limits, and token

## Sticker Usage

LINE stickers require two IDs:
- `packageId` — the sticker pack identifier
- `stickerId` — the specific sticker within the pack

Common sticker packs:
- Package 11537 (Bunny stickers) — good default set
- Package 11538 (Cat stickers)
- Package 11539 (Bear stickers)

If you don't know the exact sticker IDs, use emoji instead — they always work.

## Workflow

1. Identify the recipient (LINE user ID, group ID, or room ID — from incoming message context)
2. Determine message type (text, sticker, media, location)
3. Compose the content — **plain text for text messages, no markdown**
4. Send via the line channel tool
5. If delivery fails → check recipient ID → check message type → check rate limits

## Reactions

**LINE does NOT support reactions via the Messaging API.** Reactions are only available through the native LINE app UI — bots cannot send or receive reactions.

**Ack reactions**: Not available on LINE. If `ack_reaction` is configured globally, it will be silently skipped for LINE messages.

**Workaround**: Use a sticker or a short text reply (e.g., "👍") as an acknowledgment instead.

## Guidelines

- LINE user/group IDs are managed by the gateway; retrieve from incoming message context when replying
- For new outbound messages, the user ID must be known ahead of time
- Sticker messages require both `packageId` and `stickerId`
- Rate limits apply per LINE channel; avoid rapid-fire messaging
- The LINE bot token is in gateway configuration — never log or expose it
- For rich messages (carousel, buttons), use LINE's Flex Message format if the tool supports it
