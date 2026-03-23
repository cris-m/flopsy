---
name: brainstorming
compatibility: Designed for FlopsyBot agent
description: Collaborative design exploration before implementation. Use when the user wants to explore ideas, compare approaches, or think through a problem before committing to a solution.
---

# Brainstorming

A structured approach to exploring ideas and design options before committing to implementation.

## When to Use This Skill

- User says "let's brainstorm ..." or "what are my options for ...?"
- A problem is being defined and multiple approaches are worth considering
- The user wants to think through trade-offs before writing code or making decisions
- A design decision needs to be made and the space has not been fully explored

## Why Brainstorm Before Building

Jumping straight to implementation on the first idea that comes to mind often leads to rework. A short brainstorming phase surfaces alternatives, reveals assumptions, and helps pick the right approach before any time is invested in building it.

## Brainstorming Process

### Step 1: Define the Problem

Before generating ideas, state the problem clearly:
- What is the goal or desired outcome?
- What constraints exist? (time, budget, technology, team size)
- What does success look like?

### Step 2: Generate Options (Diverge)

Produce at least 3 distinct approaches. Do not evaluate yet -- just generate:
- What is the simplest possible solution?
- What is the most robust or scalable solution?
- What is the most creative or unconventional approach?
- What would an expert in this space recommend?

### Step 3: Evaluate Trade-Offs (Converge)

For each option, assess:

| Criteria | Option A | Option B | Option C |
|----------|----------|----------|----------|
| Complexity | Low | Medium | High |
| Time to build | 1 day | 3 days | 1 week |
| Maintainability | High | Medium | Low |
| Risk | Low | Medium | High |
| Scalability | Low | Medium | High |

### Step 4: Recommend

Based on the trade-off analysis, recommend the option that best fits the constraints. Explain why, and note what would change the recommendation.

## Output Format

```markdown
## Problem
[Clear statement of what needs to be solved]

## Constraints
- [Constraint 1]
- [Constraint 2]

## Options

### Option A: [Name]
- **Approach:** [Description]
- **Pros:** [List]
- **Cons:** [List]
- **Effort:** [Estimate]

### Option B: [Name]
[Same structure]

### Option C: [Name]
[Same structure]

## Recommendation
**Option [X]** — [Reasoning]

[Note any conditions that would change this recommendation]
```

## Guidelines

- Brainstorming is a thinking tool, not a decision tool. Present options honestly; let the user make the final call if they have context you do not.
- Avoid anchoring on the first idea. Actively generate alternatives that are meaningfully different.
- Include at least one "boring but reliable" option and one "interesting but risky" option.
- If the user already has a strong preference, still present alternatives -- they may not have considered the trade-offs.
- Pair brainstorming with the planning skill once an approach is chosen: brainstorm picks the direction, planning builds the roadmap.
