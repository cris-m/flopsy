---
name: summarization
compatibility: Designed for FlopsyBot agent
description: Structured summarization with different modes for articles, meetings, threads, and documents. Use when the user wants content condensed with key points, decisions, and action items preserved.
---

# Summarization

Structured summarization that goes beyond "make it shorter" — extract what matters and present it in the right format for the context.

## When to Use This Skill

- User says "summarize this", "TL;DR", "what's the key takeaway?"
- User shares a long article, document, or thread
- User wants meeting notes condensed
- User needs a briefing on a long conversation or email chain

## Summarization Modes

### Mode 1: Executive Summary
**When:** Decision-makers who need the bottom line fast.

```markdown
## Executive Summary

**Key Decision:** [The main decision or finding]
**Recommendation:** [What to do about it]
**Risk:** [Main risk or concern]

### Supporting Points
• [Point 1]
• [Point 2]
• [Point 3]

### Action Items
- [ ] [Action 1] — [owner] — [deadline]
- [ ] [Action 2] — [owner] — [deadline]
```

### Mode 2: Key Points Extraction
**When:** User wants the important facts without narrative.

```markdown
## Key Points

1. **[Topic]:** [Fact or finding]
2. **[Topic]:** [Fact or finding]
3. **[Topic]:** [Fact or finding]

## What's New (vs what was already known)
• [Genuinely new information]

## What's Missing
• [Gaps or unanswered questions]
```

### Mode 3: Meeting Notes
**When:** Summarizing a meeting transcript or discussion.

```markdown
## Meeting Summary: [Topic] — [Date]

### Attendees
[List if known]

### Decisions Made
1. [Decision] — rationale: [why]
2. [Decision] — rationale: [why]

### Action Items
- [ ] [Task] — assigned to [person] — due [date]
- [ ] [Task] — assigned to [person] — due [date]

### Open Questions
- [Unresolved issue 1]
- [Unresolved issue 2]

### Key Discussion Points
• [Brief summary of main topics discussed]
```

### Mode 4: Article Summary
**When:** Summarizing a news article, blog post, or research paper.

```markdown
## [Article Title]
**Source:** [Publication] — [Date]

### Thesis
[The main argument or finding in 1-2 sentences]

### Key Evidence
• [Supporting point 1]
• [Supporting point 2]

### Counter-arguments (if any)
• [What the article acknowledges or omits]

### So What?
[Why this matters — the implication]
```

### Mode 5: Thread Summary
**When:** Summarizing a long conversation, email chain, or discussion thread.

```markdown
## Thread Summary

### Context
[What started the conversation]

### Key Positions
- **[Person/Side A]:** [Their position]
- **[Person/Side B]:** [Their position]

### Resolution
[What was decided, or "unresolved"]

### Notable Quotes
> "[Important quote]" — [who said it]
```

## What to Keep vs Cut

| Keep | Cut |
|------|-----|
| Decisions and their rationale | Pleasantries and filler |
| Action items with owners | Repetition of the same point |
| New information | Background the audience already knows |
| Disagreements and their resolution | Tangents that went nowhere |
| Numbers, dates, deadlines | Vague qualifiers ("somewhat", "kind of") |
| Direct quotes that capture tone | Paraphrased versions of the same idea |

## Guidelines

- Choose the right mode based on context — don't apply the same template to everything
- Preserve specifics — "revenue grew 23%" is useful; "revenue grew significantly" is not
- Note what's missing or unclear — a summary that hides gaps is worse than no summary
- If the original contradicts itself, flag it rather than resolving it silently
- Attribute key claims — "according to [person/source]" not just bare statements
- For very long content, summarize sections first, then synthesize
- Always offer to go deeper on any point — "want me to expand on any of these?"
