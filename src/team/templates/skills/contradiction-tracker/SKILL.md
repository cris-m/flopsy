---
name: contradiction-tracker
compatibility: Designed for FlopsyBot agent
description: Track when the same person, organization, or entity says contradictory things over time. Stores statements in memory and flags inconsistencies.
---

# Contradiction Tracker

Monitor public statements from entities (politicians, companies, public figures) and flag when they contradict themselves. Contradiction is one of the strongest signals of dishonesty or incompetence.

## When to Use This Skill

- Analyzing a political speech or corporate statement
- When the user says "didn't they say the opposite before?"
- Tracking an entity's positions over time
- As part of critical-analysis-chain when analyzing claims from a known entity

## Workflow

### Step 1: Log Statements
When analyzing content from a public entity, save notable claims to memory:
```
entity:[name]:statements = [
  { date, claim, source, context }
]
```

### Step 2: Check for Contradictions
When new content from the same entity appears:
1. Load their previous statements from memory
2. Compare with current statement
3. Flag if the new statement contradicts a previous one

### Step 3: Classify the Contradiction

| Type | Description | Example |
|------|-------------|---------|
| **Direct reversal** | Opposite position on the same issue | "We will never raise taxes" → "We must raise taxes" |
| **Selective memory** | Claiming something they previously denied or vice versa | "I never said that" (but they did, on record) |
| **Moving goalposts** | Changing the criteria for success after failing the original ones | "Victory means X" → [X doesn't happen] → "Victory actually means Y" |
| **Contextual flip** | Position changes based on who benefits | "Deficits are dangerous!" (opponent in power) → "Deficits are necessary!" (own party in power) |
| **Gradual drift** | Slow, incremental shift hoping no one notices the total distance traveled | Monthly small shifts that add up to a complete reversal |

### Step 4: Assess Intent
Not all contradictions are dishonest:
- **Legitimate evolution:** "I changed my mind because new evidence [specific]" — with genuine reasoning
- **Context-dependent:** Different situations may genuinely require different approaches
- **Dishonest flip:** No acknowledgment of the change, no reasoning, and the flip conveniently serves their interests

## Output Format

```markdown
## Contradiction Alert: [Entity Name]

### Current Statement
- **Date:** [When]
- **Claim:** [What they said]
- **Source:** [Where]

### Previous Statement
- **Date:** [When]
- **Claim:** [What they said before]
- **Source:** [Where]

### Type
[Direct reversal / Selective memory / Moving goalposts / Contextual flip / Gradual drift]

### Assessment
- **Acknowledged?** [Did they address the change? Yes/No]
- **Reasoning given?** [Did they explain why? What was it?]
- **Who benefits?** [Does the flip conveniently serve their interests?]
- **Verdict:** [Legitimate evolution / Suspicious / Dishonest]
```

## Memory Management

- Store up to 20 key statements per tracked entity
- Prioritize: commitments, promises, policy positions, factual claims
- Drop vague or non-specific statements — track concrete, verifiable claims
- Tag statements by topic so contradictions are matched correctly

## Guidelines

- Everyone changes their mind sometimes. The question is whether they acknowledge it honestly
- Politicians are the highest-priority tracking targets — they make public commitments and are accountable
- Corporate statements are also worth tracking, especially around product launches, layoffs, and earnings
- Always include source links so contradictions are verifiable
- Present contradictions factually — let the evidence speak. Don't editorialize beyond the classification
- Pair with mental-models (incentive analysis) to understand WHY the contradiction happened
