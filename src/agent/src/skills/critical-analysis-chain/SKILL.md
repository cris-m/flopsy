---
name: critical-analysis-chain
compatibility: Designed for FlopsyBot agent
description: Orchestration skill that auto-chains source assessment, propaganda recognition, mental models, historical parallels, and self-critique when analyzing external content. Use when the user shares a tweet, article, speech, or claim for analysis.
---

# Critical Analysis Chain

The master orchestration skill. When external content needs analysis, run it through this pipeline instead of applying skills ad hoc.

## When to Use This Skill

- User shares a tweet, article, video, or political statement
- User asks "what do you think about this?", "is this legit?", "analyze this"
- User shares a link to external content that makes claims
- Any external content that the user is relying on for decisions

## The Pipeline

Execute these steps in order. Each builds on the previous.

### Step 1: Source Assessment
*(source-assessment skill)*
- Who said/wrote this? Are they credible?
- What's the publication/platform? Trustworthy?
- Is it dated? Current?
- Quick manipulation pattern scan

**Gate:** If the source is suspect, flag immediately. Continue analysis but with prominent caveats.

### Step 2: Propaganda & Manipulation Scan
*(propaganda-recognition skill)*
- Scan for: emotional hijacking, manufactured urgency, us-vs-them framing, false authority, bandwagon, scapegoating
- Count the flags: 0-1 = clean, 2 = caution, 3+ = suspect

### Step 3: Argument Mapping
*(argument-mapping skill)*
- What's the conclusion being pushed?
- What are the stated premises?
- What are the hidden assumptions?
- Any logical fallacies?

### Step 4: Mental Model Application
*(mental-models skill)*
Select the most relevant models (typically 2-3):
- **Cui Bono** — who benefits from this narrative?
- **Incentive Analysis** — what drives each actor?
- **Second-Order Thinking** — what happens next, and after that?
- **Base Rate** — how often do similar claims turn out to be true?

### Step 5: Historical Parallel
*(historical-parallel skill)*
- Has this pattern occurred before?
- What was the outcome?
- What's different this time (if anything)?

### Step 6: Multi-Perspective Analysis
*(multi-perspective skill)*
- How do different stakeholders see this?
- Whose perspective is missing?
- Where do interests align and conflict?

### Step 7: Self-Critique
*(self-critique skill)*
- What am I wrong about in my analysis?
- What counter-arguments exist?
- What am I assuming?
- Calibrate confidence

### Step 8: Synthesize

Combine all steps into a clear verdict.

## Output Format

```markdown
## Critical Analysis: [Content Title/Description]

### Source
- **Who:** [Author/speaker]
- **Where:** [Platform/publication]
- **Credibility:** [Clean / Flagged / Suspect]

### Manipulation Scan
- **Patterns found:** [List, or "none detected"]
- **Severity:** [None / Low / Medium / High]

### Argument Structure
- **Claim:** [What they're arguing]
- **Strongest premise:** [Best supporting point]
- **Weakest link:** [Where the logic breaks]
- **Hidden assumption:** [What they assume you'll accept]

### Who Benefits
[Cui bono analysis — follow the money/power]

### Historical Precedent
[What happened before when similar claims were made]

### Stakeholder Perspectives
- **[Perspective 1]:** [View]
- **[Perspective 2]:** [View]
- **[Perspective 3]:** [View]

### Self-Critique
- **My strongest counter-argument:** [What challenges my analysis]
- **What I might be missing:** [Acknowledged gap]

### Verdict
[Clear assessment — what the content is really saying vs what it claims]
**Confidence:** [High / Medium / Low]
**Recommendation:** [What the user should take away]
```

## Depth Calibration

Not every piece of content needs the full pipeline:

| Content Type | Depth | Steps |
|-------------|-------|-------|
| Casual news article | Light | Steps 1-2, then verdict |
| Political statement | Full | All 8 steps |
| Investment pitch / deal | Full | All 8 steps |
| Friend's shared article | Medium | Steps 1-3, 7, then verdict |
| Breaking news | Light first, deepen later | Steps 1-2 now, full when more info available |

## Guidelines

- This is the most comprehensive analysis Flopsy can do. Use the full pipeline for content that matters
- Don't overwhelm the user with the full output on casual questions — calibrate depth
- Speed matters: for quick "is this legit?" questions, run steps 1-2 fast and give a quick verdict, then offer to go deeper
- The pipeline is sequential — each step informs the next. Don't skip steps for important content
- Always end with a clear, actionable verdict. Analysis without conclusion is just noise
