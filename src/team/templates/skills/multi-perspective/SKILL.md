---
name: multi-perspective
compatibility: Designed for FlopsyBot agent
description: Analyze any situation from 3+ stakeholder viewpoints before forming a position. Prevents single-perspective blindness.
---

# Multi-Perspective Analysis

Never form a position from a single viewpoint. Identify all stakeholders, analyze each one's incentives and constraints, then synthesize.

## When to Use This Skill

- Analyzing political events, business decisions, or conflicts
- When the user is only seeing one side of an issue
- As part of critical-analysis-chain
- Any situation with multiple actors who have different interests

## Workflow

### Step 1: Identify Stakeholders
List everyone with a stake in the outcome:
- Direct participants (the decision-makers)
- Affected parties (who bears the consequences)
- Silent stakeholders (future generations, the environment, the voiceless)
- The audience (who is the message for?)

### Step 2: Analyze Each Perspective

For each stakeholder:
- **What do they want?** (stated goals)
- **What do they actually want?** (underlying incentives)
- **What are their constraints?** (what limits their options)
- **What are they afraid of?** (what drives defensive behavior)
- **What information do they have/lack?**

### Step 3: Map Alignment and Conflict

- Where do interests align? (potential for cooperation)
- Where do interests conflict? (source of tension)
- Who has the most power? Who has the least?
- Whose perspective is being amplified? Whose is being suppressed?

### Step 4: Synthesize

Form your assessment by integrating all perspectives. The best analysis explains why each actor is behaving as they are — even the ones you disagree with.

## Output Format

```markdown
## Multi-Perspective Analysis: [Topic]

### Stakeholder Map

#### [Stakeholder 1: Name/Group]
- **Stated position:** [What they say]
- **Underlying interest:** [What they actually want]
- **Constraints:** [What limits them]
- **Blind spot:** [What they're not seeing]

#### [Stakeholder 2: Name/Group]
[Same structure]

#### [Stakeholder 3: Name/Group]
[Same structure]

### Alignment & Conflict
- **Aligned on:** [Where interests overlap]
- **Conflict on:** [Where interests clash]
- **Power imbalance:** [Who has leverage]

### Synthesis
[Integrated assessment that explains the dynamics]
```

## Guidelines

- Minimum 3 perspectives. If you can only find 2, you're not looking hard enough
- Empathy is not agreement. Understanding why someone acts a certain way doesn't mean endorsing it
- Include the perspective of those who have no voice in the discussion
- Note which perspective is dominant in media coverage — the missing ones are often the most informative
- Pair with mental-models (incentive analysis, cui bono) for deeper stakeholder analysis
