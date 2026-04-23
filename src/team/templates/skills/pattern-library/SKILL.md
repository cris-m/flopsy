---
name: pattern-library
compatibility: Designed for FlopsyBot agent
description: Accumulate and recognize recurring patterns across conversations. When analyzing content, check for known patterns and save new ones to memory for future recognition.
---

# Pattern Library

Build and maintain a library of recurring patterns. When you see something once, analyze it. When you see it twice, it's a coincidence. When you see it three times, it's a pattern — save it.

## When to Use This Skill

- During any analysis (political, business, technical, social)
- When content triggers recognition of a pattern you've seen before
- When saving a new pattern identified during analysis
- Automatically as part of critical-analysis-chain

## Pattern Categories

### Political Patterns
| Pattern | Description | Historical Examples |
|---------|-------------|-------------------|
| **Foreign Savior** | Leader promises a foreign power will solve domestic problems | Mobutu/Belgium, Kabila/China, countless IMF/World Bank "structural adjustment" programs |
| **Blame Shifting** | Leader attributes domestic failures to external enemies | "The opposition/foreigners/sanctions caused this" |
| **Manufactured Crisis** | Create urgency to justify extraordinary measures | Declaring emergency to bypass legislative oversight |
| **Promise Recycling** | Same promises from new leaders without structural change | "This time the development plan will work" |
| **Sovereignty for Sale** | Trading national sovereignty for personal/elite power | Resource extraction deals that benefit the few |

### Business Patterns
| Pattern | Description | Red Flags |
|---------|-------------|-----------|
| **Hype Cycle** | Product announced with grand claims, delivered with compromises | No working demo, "revolutionary" language, vague timeline |
| **Vaporware** | Announced to freeze competitors, never actually built | Announcement timing coincides with competitor's launch |
| **Regulatory Capture** | Industry writes its own regulations via lobbying | Former industry executives in regulatory positions |
| **Growth at All Costs** | Burning capital to show growth metrics while fundamentally unprofitable | "We'll figure out profitability later" |

### Information Patterns
| Pattern | Description | Detection |
|---------|-------------|-----------|
| **Astroturfing** | Fake grassroots support manufactured by organized actors | Suspiciously similar messaging across "independent" accounts |
| **Narrative Laundering** | False claim planted in small outlet, cited by larger ones as "reports say" | Circular citations, original source is obscure |
| **Coordinated Inauthenticity** | Network of accounts amplifying the same message | Timing coordination, shared language patterns |
| **Outrage Manufacturing** | Deliberately provocative content designed to generate engagement via anger | Inflammatory framing of mundane events |

## How to Use

### Recognizing Patterns
When analyzing new content:
1. Strip the situation to its structural pattern (remove names, dates, specifics)
2. Check: does this match a known pattern?
3. If yes: apply the historical knowledge associated with that pattern
4. Note what's different this time (no pattern is a perfect match)

### Saving New Patterns
When you identify a new recurring pattern:
1. Name it clearly
2. Describe the structural pattern (not the specific instance)
3. List 2-3 examples you've observed
4. Note the typical outcome
5. Save to memory for future conversations

### Pattern Matching Output
```markdown
## Pattern Match: [Pattern Name]

**Observed in:** [Current event]
**Pattern:** [Structural description]
**Previous instances:** [2-3 examples]
**Typical outcome:** [What usually happens]
**What's different this time:** [Notable differences]
**Confidence:** [High / Medium / Low]
```

## Guidelines

- Patterns are heuristics, not certainties. Always note what's different
- Avoid pattern-matching to the point of cynicism — sometimes things genuinely are new
- Save patterns to memory so they accumulate across conversations
- A pattern recognized early can prevent repeated mistakes
- Share pattern recognition with the user: "I've seen this pattern before — here's what usually happens"
- Pair with historical-parallel for grounding patterns in specific precedents
