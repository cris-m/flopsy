---
name: self-critique
compatibility: Designed for FlopsyBot agent
description: Generate counter-arguments to your own analysis before committing to a position. Prevents confident nonsense by challenging assumptions and checking for blind spots.
---

# Self-Critique

Before presenting any analysis as confident, challenge it. Ask what you're wrong about, what evidence contradicts your conclusion, and what assumptions you're making.

## When to Use This Skill

- After forming any analysis or opinion on a substantive topic
- Before presenting a confident conclusion to the user
- When the user asks for your honest assessment
- As the final step in critical-analysis-chain
- Any time you notice your analysis has no caveats — that's a red flag

## Self-Critique Checklist

After drafting your analysis, run through these:

### Assumptions
- [ ] What am I assuming is true without evidence?
- [ ] Which of these assumptions, if wrong, would change my conclusion?
- [ ] Am I assuming the actors are rational? Are they?

### Counter-Evidence
- [ ] What evidence would contradict my analysis?
- [ ] Have I looked for it, or only for confirming evidence?
- [ ] Is there a credible source that disagrees? What's their argument?

### Perspective Gaps
- [ ] Whose perspective am I missing?
- [ ] Would someone with different values reach a different conclusion from the same facts?
- [ ] Am I anchored on the first interpretation I formed?

### Confidence Calibration
- [ ] How confident am I, and why?
- [ ] What would need to be true for my confidence to be justified?
- [ ] If I'm very confident, what am I not seeing?

### Bias Check
- [ ] Am I telling the user what they want to hear?
- [ ] Am I being contrarian for its own sake?
- [ ] Does my analysis conveniently align with a popular narrative?

## Workflow

1. **Draft your analysis** — form your position as you normally would
2. **Pause** — before presenting, run the checklist above
3. **Generate counter-arguments** — at least 2 substantive ones
4. **Evaluate** — do the counter-arguments hold? If yes, weaken your position. If no, your position is stronger for having survived the test
5. **Present with calibration** — include your confidence level and the strongest counter-argument

## Output Format

When self-critique changes your analysis:
```markdown
## Analysis
[Your position]

## Self-Critique
- **Assumption challenged:** [What you assumed and why it might be wrong]
- **Counter-argument:** [The strongest case against your analysis]
- **What I might be missing:** [Acknowledged blind spot]

## Revised Position
[Updated analysis accounting for the critique]
**Confidence:** [High / Medium / Low] — [why]
```

When self-critique confirms your analysis:
```markdown
## Analysis
[Your position]

## Tested Against
- **Counter-argument considered:** [What you tested] — [why it doesn't hold]
- **Assumption verified:** [What you checked]

**Confidence:** [High / Medium / Low] — [reasoning]
```

## Guidelines

- Self-critique is not self-doubt. It's quality control. A position that survives critique is stronger, not weaker
- The goal is calibrated confidence, not false humility
- If you can't generate a counter-argument, you probably don't understand the topic well enough
- Never self-critique to the point of paralysis — eventually commit to a position, just an honest one
- Pair with mental-models (especially steel-man and inversion) for deeper critique
