---
name: decision-framework
compatibility: Designed for FlopsyBot agent
description: Structured decision-making with pros/cons, second-order effects, regret minimization, and pre-mortem analysis. Use when the user faces a significant choice.
---

# Decision Framework

Structured methodology for making decisions under uncertainty. Goes beyond simple pros/cons to include second-order effects, reversibility, and pre-mortem analysis.

## When to Use This Skill

- User says "should I...?", "what would you do?", "help me decide"
- User is choosing between job offers, investments, strategies, or life decisions
- User is stuck in analysis paralysis
- Any decision with significant consequences

## Workflow

### Step 1: Define the Decision
- What exactly is being decided?
- What are the options? (at least 2, look for a third)
- What's the timeline? When must this be decided by?
- Is this reversible or irreversible?

### Step 2: Pros/Cons Matrix

| Factor | Option A | Option B | Option C |
|--------|----------|----------|----------|
| [Factor 1] | + / - / = | + / - / = | + / - / = |
| [Factor 2] | ... | ... | ... |
| **Weight** | [How much this factor matters] |

Weight the factors. Not all pros/cons are equal — a major financial risk outweighs a minor inconvenience.

### Step 3: Second-Order Effects
For each option, ask "and then what?" two levels deep:
- Option A → leads to X → which leads to Y
- Does Y change your assessment of A?

### Step 4: Regret Minimization
Project yourself 5 years into the future:
- "If I choose A and it fails, how much will I regret it?"
- "If I don't choose A and miss the opportunity, how much will I regret it?"
- Which regret is worse?

### Step 5: Reversibility Assessment
- **Easily reversible:** Bias toward action. Try it, learn, adjust.
- **Hard to reverse:** Bias toward caution. Gather more information.
- **Irreversible:** Apply maximum rigor before committing.

### Step 6: Pre-Mortem
Imagine you chose each option and it failed spectacularly:
- What went wrong?
- Was the failure foreseeable?
- What would you have wished you'd considered?

### Step 7: Recommend
Based on all the above, make a recommendation. But make the reasoning transparent — the user decides, not you.

## Output Format

```markdown
## Decision Analysis: [What's being decided]

### Options
- **A:** [Description]
- **B:** [Description]
- **C:** [Description, if applicable]

### Pros/Cons

| Factor | Option A | Option B |
|--------|----------|----------|
| [Factor] | [Assessment] | [Assessment] |

### Second-Order Effects
- **A →** [first effect] **→** [second effect]
- **B →** [first effect] **→** [second effect]

### Reversibility
- **A:** [Reversible / Partially / Irreversible]
- **B:** [Reversible / Partially / Irreversible]

### Pre-Mortem
- **A fails because:** [Most likely failure mode]
- **B fails because:** [Most likely failure mode]

### Recommendation
**Option [X]** — [Reasoning]
**Caveat:** [What would change this recommendation]
```

## Guidelines

- Present the analysis, not just the answer. The user needs to see the reasoning to make their own call
- If you don't have enough information, say what you'd need to know before deciding
- For irreversible decisions, always do the pre-mortem
- "Both options are reasonable" is a valid conclusion — not every decision has a clear winner
- Never rush someone into a decision. If they need more time, that's a valid choice too
- Pair with mental-models (opportunity cost, inversion) for deeper analysis
