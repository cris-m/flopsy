---
name: mental-models
compatibility: Designed for FlopsyBot agent
description: Library of thinking frameworks applied automatically when analyzing claims, events, or decisions. Includes Cui Bono, Second-Order Thinking, Steel Man, Incentive Analysis, and more.
---

# Mental Models

A library of thinking frameworks. Do not just describe what happened — apply these models to understand why it happened, who benefits, and what comes next.

## When to Use This Skill

- Analyzing any claim, proposal, or decision
- Evaluating political statements, business deals, or policy changes
- User asks "what do you think about...?" or "should I...?"
- Any situation where surface-level analysis would miss the real dynamics
- Automatically when using critical-analysis-chain

## The Models

### 1. Cui Bono (Who Benefits?)

For every claim, trace the money and power:
- Who gains if this is true/accepted?
- Who gains if people believe this regardless of truth?
- Follow the incentives, not the words.

**Apply when:** Someone proposes something framed as altruistic. Ask "who actually benefits from this arrangement?"

### 2. Second-Order Thinking

Don't stop at the obvious consequence. Ask "and then what?" three levels deep:

```
Action → First-order effect → Second-order effect → Third-order effect
```

**Apply when:** Evaluating a decision, policy, or deal. The first-order effect is what they tell you. The second and third are where the real consequences live.

### 3. Steel Man

Before criticizing a position, construct the strongest possible version of it:
- What would a reasonable, intelligent person mean by this?
- What context might make this position rational?
- What evidence supports it?

Then critique the steel man, not the straw man. If your critique holds against the strongest version, it's a real critique.

**Apply when:** You're about to dismiss something. Build the best case for it first.

### 4. Incentive Analysis

People respond to incentives. Map them:
- What are each actor's incentives? (financial, political, social, personal)
- Where do incentives align with stated goals?
- Where do incentives contradict stated goals?
- What would a rational actor do given these incentives, regardless of what they say?

**Apply when:** Someone's actions don't match their words. The incentives usually explain the gap.

### 5. Hanlon's Razor

Never attribute to malice that which is adequately explained by incompetence. But also:
- Once incompetence is ruled out, consider malice
- Pattern of "mistakes" that consistently benefit the same party suggests more than incompetence
- Incompetence and malice are not mutually exclusive

**Apply when:** Something goes wrong. Start with incompetence, escalate to malice only with evidence.

### 6. Survivorship Bias

What are you NOT seeing?
- Success stories are visible; failures are silent
- The data you have is filtered by survival — the dead don't report
- Ask: "What would the failures look like? Would I even know about them?"

**Apply when:** Someone cites examples of success. Ask how many tried and failed invisibly.

### 7. Inversion

Instead of asking "how do I succeed?", ask "what would guarantee failure?" Then avoid those things.
- What would make this deal catastrophic?
- What assumptions, if wrong, would destroy the plan?
- What has historically caused similar things to fail?

**Apply when:** Planning or evaluating a strategy. The failure modes are often more informative than the success path.

### 8. Base Rate

What's the historical success rate of similar things?
- Before believing "this time is different," check the base rate
- If 90% of similar ventures fail, you need strong evidence for why this one won't
- Extraordinary claims require extraordinary evidence — and extraordinary base rates

**Apply when:** Someone claims exceptional outcomes. Check what normally happens.

### 9. Map vs Territory

The description of reality is not reality itself:
- Models are simplifications — useful but incomplete
- When the map contradicts the territory, trust the territory
- People often argue about maps (narratives, models) while ignoring the territory (actual data)

**Apply when:** There's a gap between official narrative and observable reality.

### 10. Opportunity Cost

Every choice has a cost — the best alternative you didn't choose:
- "Is this good?" is the wrong question. "Is this better than the alternatives?" is the right one
- Time, money, and attention spent here can't be spent elsewhere

**Apply when:** Evaluating whether to do something. Always ask "compared to what?"

## How to Apply

When analyzing anything substantive, select 2-4 relevant models and apply them explicitly:

```markdown
## Analysis: [Topic]

### Cui Bono
[Who benefits and how]

### Second-Order Effects
1. [First order]: [obvious consequence]
2. [Second order]: [what follows from that]
3. [Third order]: [what follows from that]

### Steel Man
[Strongest case for the position being analyzed]

### Verdict
[Your assessment after applying the models]
```

## Guidelines

- Not every model applies to every situation — select the relevant ones
- Models are lenses, not answers. They help you see; they don't decide for you
- When models conflict (Hanlon's Razor vs Cui Bono), note the tension explicitly
- Always apply steel-man before critiquing — it sharpens your analysis even when you ultimately disagree
- Pair with historical-parallel to ground the models in real precedent
