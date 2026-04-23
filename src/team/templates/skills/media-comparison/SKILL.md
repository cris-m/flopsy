---
name: media-comparison
compatibility: Designed for FlopsyBot agent
description: Compare how different media outlets cover the same story. Detect framing differences, bias direction, and what each source includes or excludes.
---

# Media Comparison

Compare coverage of the same event across multiple outlets to reveal framing, bias, and editorial choices.

## When to Use This Skill

- User asks "how is [outlet] vs [outlet] covering this?"
- User wants to understand media bias on a specific story
- Part of research on a controversial or polarizing topic
- User says "give me multiple perspectives on this story"

## Process

### Step 1: Identify the Story
Define the core event (stripped of framing): "What happened, to whom, when?"

### Step 2: Gather Coverage
Search 3+ outlets with different editorial positions:
- **Wire service** (AP, Reuters, AFP) — baseline factual reporting
- **Left-leaning** (Guardian, NYT, Al Jazeera)
- **Right-leaning** (WSJ editorial, Telegraph, Fox News)
- **Regional/local** — the perspective closest to the event
- **Non-Western** — if relevant (Xinhua, RT, TRT — note state affiliation)

### Step 3: Compare Framing

For each outlet, analyze:

| Element | What to Compare |
|---------|----------------|
| **Headline** | Tone, emphasis, word choice |
| **Lead paragraph** | What's presented as most important |
| **Sources quoted** | Who gets to speak? Who's absent? |
| **Language** | Neutral vs loaded words for the same facts |
| **What's included** | Facts each outlet chose to present |
| **What's excluded** | Facts each outlet left out |
| **Placement** | Front page vs buried, prominence |
| **Images** | Which photos were chosen and what they convey |

### Step 4: Identify Bias Direction
- **Selection bias:** Which facts were included/excluded?
- **Framing bias:** How is the same fact presented? ("Protesters" vs "rioters")
- **Source bias:** Who is quoted and who is not?
- **Omission:** What's systematically absent across one outlet but present in others?

### Step 5: Synthesize
What's the most accurate picture when you combine all sources?

## Output Format

```markdown
## Media Comparison: [Story]

### Core Facts (agreed across sources)
- [Fact 1]
- [Fact 2]

### Coverage Comparison

| Element | [Outlet 1] | [Outlet 2] | [Outlet 3] |
|---------|------------|------------|------------|
| Headline | [text] | [text] | [text] |
| Framing | [neutral/sympathetic/critical] | ... | ... |
| Key sources quoted | [who] | [who] | [who] |
| Notable inclusion | [what] | [what] | [what] |
| Notable omission | [what] | [what] | [what] |

### Framing Differences
- [Specific difference and what it reveals]

### Most Balanced Account
[Which source or combination gives the fullest picture]

### What No One Is Reporting
[Gaps across all coverage]
```

## Guidelines

- Wire services (AP, Reuters) are the closest to neutral — use as a baseline
- State-affiliated media (RT, Xinhua, TRT) are not independent — always note the affiliation
- "Balanced" does not mean "both sides get equal space." It means proportional to evidence
- The most revealing comparison is often what an outlet excludes, not what it includes
- Pair with source-assessment for credibility checks on individual outlets
