---
name: geopolitical-analysis
compatibility: Designed for FlopsyBot agent
description: Framework for analyzing geopolitical events, deals, and statements. Maps power dynamics, resource interests, historical context, and cui bono. Use when analyzing political statements, international deals, or conflicts.
---

# Geopolitical Analysis

Systematic framework for understanding power dynamics, resource flows, and strategic interests behind political events and international deals.

## When to Use This Skill

- Analyzing an international deal, treaty, or agreement
- Evaluating a political leader's statement about foreign relations
- Understanding a conflict, sanctions, or diplomatic event
- User shares a political claim and wants it analyzed
- As part of critical-analysis-chain for political content

## Analysis Framework

### 1. Power Dynamics Map
- Who are the actors? (states, leaders, corporations, institutions)
- What leverage does each actor have? (military, economic, resource, geographic)
- What is the power asymmetry? (who needs whom more?)
- Who is absent from the table but affected?

### 2. Resource & Economic Interests
- What natural resources are at stake? (minerals, energy, water, land)
- What trade routes or geographic advantages matter?
- What is the economic dependency structure? (who buys, who sells, who finances)
- Follow the money: who profits from the current arrangement vs the proposed change?

### 3. Historical Context
- What is the history between these actors? (colonial, alliance, conflict)
- What previous deals/attempts look like this? (use historical-parallel skill)
- What promises were made before and what actually happened?
- What grievances or debts influence the current dynamic?

### 4. Domestic vs International Incentives
- Is the leader speaking to a domestic audience or an international one?
- Does the statement serve domestic political survival more than foreign policy?
- What internal pressures drive the external positioning?
- Is this a distraction from domestic failures?

### 5. Alliance & Opposition Structure
- Who supports this arrangement? Why?
- Who opposes it? Why?
- What regional or global rivalries does this fit into? (US-China, etc.)
- Whose influence increases or decreases as a result?

### 6. Cui Bono (Who Benefits?)
- Short-term beneficiaries vs long-term beneficiaries
- Who benefits from the DEAL vs who benefits from the NARRATIVE
- What does each side give up? Is it proportional?
- Who bears the costs? (often not the ones at the table)

## Output Format

```markdown
## Geopolitical Analysis: [Event/Deal/Statement]

### Context
[What happened and who said what]

### Power Dynamics
- **Actor A:** [Leverage, position, goals]
- **Actor B:** [Leverage, position, goals]
- **Asymmetry:** [Who needs whom more]

### Resource Interests
- [What's at stake materially]
- [Trade/economic dependencies]

### Historical Precedent
- [Similar past events and their outcomes]

### Domestic Politics
- [How this serves each leader's domestic audience]

### Cui Bono
- **Short-term:** [Who benefits now]
- **Long-term:** [Who benefits over time]
- **Who pays:** [Who bears the cost]

### Assessment
[What's really happening vs what's being said]
**Confidence:** [High / Medium / Low]
```

## Guidelines

- Maps are not territories. Geopolitical analysis is always a simplification — state your assumptions
- Every actor is rational from their own perspective, even when their actions seem foolish from outside
- Beware of narrative framing — "partnership" often means one side has leverage, "aid" often comes with strings
- Always check who is NOT at the table but will be affected by the outcome
- A leader's statement tells you about their audience, not necessarily about reality
- Pair with historical-parallel, multi-perspective, and mental-models for depth
