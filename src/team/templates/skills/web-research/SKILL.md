---
name: web-research
compatibility: Designed for FlopsyBot agent
description: Structured multi-source web research with source verification. Use when the user wants current information on a topic, needs facts checked, or wants a research summary.
---

# Web Research

Structured multi-source research methodology for gathering accurate, current information from the web.

## When to Use This Skill

- User says "research ..." or "find out about ..."
- User needs current information that may have changed recently
- User wants facts verified across multiple sources
- A task requires background information before proceeding

## Core Principle: Never Rely on a Single Source

Every research query should produce at least 3 independent sources. A single source can be wrong, outdated, or biased.

## Workflow

### Step 1: Plan the Queries

Before searching, plan 3-5 queries that cover different angles of the topic:

| Angle | Example Query |
|-------|---------------|
| General overview | "[topic] overview 2026" |
| Recent updates | "[topic] news latest" |
| Technical details | "[topic] how it works explained" |
| Comparisons | "[topic] vs alternatives" |
| Expert opinion | "[topic] analysis review" |

### Step 2: Execute Searches

Run the planned queries using `web_search`. Where possible, run independent searches in parallel.

### Step 3: Evaluate Sources

For each result, assess credibility and scan for manipulation:
- Is the source authoritative? (official site, reputable publication, academic)
- Is the content current? (check the publication date)
- Does it align with or contradict other sources?
- Any manipulation patterns? (urgency, FUD, false authority, us-vs-them, emotional hijacking)
- Prioritize clean sources. Flag suspect ones with specific reasons.

See the **source-assessment** skill for the full manipulation pattern list and credibility framework.

### Step 4: Deep Dive on Key Findings

For the most important or surprising findings, use `web_extract` to get the full article content. Look for:
- Supporting data, statistics, or quotes
- Context that the snippet did not capture
- Links to primary sources

### Step 5: Cross-Reference

If sources disagree on a fact, note the discrepancy. Present it honestly rather than picking one side without evidence.

### Step 6: Synthesize

Combine findings into a structured summary with source attribution.

## Output Format

```markdown
## Summary
[2-3 sentence overview of key findings]

## Key Findings
- **Finding 1**: [Description] (Source: [name](url))
- **Finding 2**: [Description] (Source: [name](url))
- **Finding 3**: [Description] (Source: [name](url))

## Details
[Deeper explanation of the most important points]

## Sources
- [Source 1 Name](url)
- [Source 2 Name](url)
- [Source 3 Name](url)
```

## Guidelines

- Always include source URLs in the output so the user can verify
- Note confidence level for each finding (high / medium / low) when sources are sparse or contradictory
- For time-sensitive topics, include the date of each source
- Do not present information as fact if it comes from only one source; use hedging language ("according to X", "reportedly")
- If the research topic is outside the scope of available tools (e.g., paywalled content), be transparent about the limitation
