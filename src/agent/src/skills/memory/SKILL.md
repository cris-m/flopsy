---
name: memory
compatibility: Designed for FlopsyBot agent
description: Working memory system for persisting and retrieving information across sessions. Includes user profiling, topic tracking, and memory consolidation. Use when persisting context, profiling the user, or managing long-term memory.
---

# Memory

Working memory system for continuity across sessions. Memory is not just storage — it's how you recognize the user, avoid repeating yourself, and get smarter over time.

## When to Use This Skill

- User says "remember this" or "note that for later"
- You need prior context from an earlier session
- A heartbeat needs to know what topics were already covered
- You observe something about the user worth recording (style, interests, patterns)
- End of a conversation — consolidate what you learned

## Memory Architecture

| File | Purpose | Update When |
|------|---------|-------------|
| `USER.md` | Who you're helping: name, style, interests, anti-patterns | Every conversation |
| `MEMORY.md` | Long-term: decisions, milestones, patterns | Significant events |
| `memory/YYYY-MM-DD.md` | Daily log: raw events, decisions | During the day |
| `memory/WORKING.md` | Current task state, shared across agents | During active work |

## User Profiling (CRITICAL)

You are a profiler. Don't wait for the user to tell you about themselves — **observe and infer**.

### What to Observe

| Signal | What It Tells You | Where to Record |
|--------|-------------------|-----------------|
| Message length | Short = terse, long = detailed | USER.md → Communication Style |
| Vocabulary | Technical terms = expert, casual = beginner | USER.md → Technical Level |
| Topics asked about | Interests and current focus | USER.md → Topics of Interest |
| When they message | Timezone and schedule patterns | USER.md → Timezone |
| What annoys them | Anti-patterns to avoid | USER.md → Anti-Patterns |
| Corrections they give | Highest-confidence behavioral signal | USER.md → Anti-Patterns + learn() |
| Links they share | Interests, current research | USER.md → Topics of Interest |
| Emoji usage | Casual vs formal tone preference | USER.md → Communication Style |

### Profiling Rules

1. **Infer constantly** — every message teaches you something
2. **Update immediately** — don't wait until end of session
3. **Corrections are gold** — exact user quotes go in Anti-Patterns
4. **Empty USER.md after a real conversation = failure**
5. USER.md drives heartbeat topic rotation — empty = repetitive

### Example USER.md Update

After a user sends: "something like chip manufacturing. build computer component like computer built. hacking, AI, military, space, galaxy,..."

```
edit_file USER.md:
Topics of Interest:
- Chip manufacturing / semiconductor fabrication
- Computer hardware / building computers
- Hacking / cybersecurity
- Artificial intelligence
- Military technology
- Space exploration
- Galaxies / astronomy
```

## Topic Tracking (Anti-Repetition)

Track what you've proactively shared to avoid repeating topics.

### How It Works

1. Before generating proactive content, check:
   - `memory/WORKING.md` — recent topics
   - Heartbeat context `recentTopics` — what was already covered
   - `USER.md → Topics of Interest` — rotate through these

2. After sharing proactive content:
   - Log the topic to daily memory: `memory/YYYY-MM-DD.md`
   - The heartbeat system tracks `recentTopics` automatically

### Rules

- **Never** repeat a topic within 7 days unless genuinely new developments (with new URLs)
- When user says "you already talked about X" → add to USER.md Anti-Patterns immediately
- Rotate through USER.md interests — don't fixate on one
- If you catch yourself about to write about the same thing → stop → pick something else

## Saving to Memory

### Quick Save (user says "remember this")
1. Identify the fact or preference
2. Is it about the user? → `edit_file USER.md`
3. Is it a one-time fact? → append to `memory/YYYY-MM-DD.md`
4. Is it a durable pattern? → `learn(type: "observation")` — the nightly reflection consolidates into MEMORY.md
5. Confirm briefly: "Got it, saved."

### End-of-Conversation Consolidation
After every meaningful conversation, ask yourself:

1. **What did I learn about this person?** → update USER.md
2. **What happened today?** → append to daily log
3. **Any pattern worth keeping long-term?** → `learn(type: "observation")` or `learn(type: "win")` — do NOT edit MEMORY.md directly. The nightly reflection deduplicates, scores confidence, and consolidates patterns into MEMORY.md.
4. **Did I make a mistake the user corrected?** → Anti-Patterns + `learn(type: "correction")`

**IMPORTANT:** Never edit MEMORY.md directly during conversations. Always route through `learn()`. Direct edits bypass deduplication and cause repetitive entries.

## Retrieving from Memory

Before asking the user for information:
1. Check loaded context (USER.md, MEMORY.md already in prompt)
2. Check `memory/YYYY-MM-DD.md` for recent days
3. Check `memory/WORKING.md` for active task state
4. Only if not found → ask the user

## User Corrections

When a user explicitly corrects your behavior:

1. **This is the highest-confidence signal you will ever get**
2. Add exact quote to `USER.md → Anti-Patterns`
3. Call `learn(type: "correction", content: "[exact user quote]")`
4. Acknowledge briefly and change behavior immediately
5. These corrections override ALL other signals

## Guidelines

- Memory files should be small and focused — split if they grow large
- Always read memory before tasks that might have prior context
- Never store secrets (passwords, API keys) in memory files
- Periodically review and prune stale entries
- Daily logs are raw — MEMORY.md is curated
- When in doubt, write it down — text > brain
