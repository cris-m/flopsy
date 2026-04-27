---
name: historical-parallel
compatibility: Designed for FlopsyBot agent
description: Find historical analogues for current events and check what happened. Use when analyzing political statements, deals, conflicts, or any claim that has likely been tried before.
---

# Historical Parallel

For any current event, find the closest historical precedent and check the outcome. History doesn't repeat, but it rhymes — and the rhymes are informative.

## When to Use This Skill

- Analyzing political promises, international deals, or policy proposals
- User asks "has this been done before?" or "what usually happens when...?"
- A leader makes claims about what will happen — check what happened when similar claims were made
- Evaluating business strategies, economic policies, or social movements
- As part of critical-analysis-chain

## Workflow

### Step 1: Identify the Pattern
Strip the current event to its structural pattern:
- "Foreign power promises to build a developing nation's military" (not "US promises to help DRC")
- "Government nationalizes a key industry" (not "Bolivia nationalizes lithium")
- "Startup promises revolutionary technology with no prototype" (not "Company X claims AI breakthrough")

### Step 2: Search for Precedents
Find 2-5 historical cases matching the pattern:
- Use web_search with historical framing: "[pattern] historical examples"
- Check different regions and time periods
- Include both successes and failures

### Step 3: Compare Contexts
For each precedent, assess:

| Factor | Historical Case | Current Event |
|--------|----------------|---------------|
| Power dynamics | [Who had leverage] | [Who has leverage now] |
| Economic conditions | [State of economy then] | [State now] |
| Institutional strength | [Were institutions strong/weak] | [Now] |
| External pressures | [What else was happening] | [What else is happening] |
| Key actors' incentives | [What did they want] | [What do they want] |

### Step 4: Note What's Different
No parallel is perfect. Explicitly state:
- What's genuinely different about the current situation
- Whether those differences make the historical outcome more or less likely
- Whether the actors involved have access to the historical knowledge (and whether they're ignoring it)

### Step 5: Draw Conclusions
Based on the pattern and its historical outcomes:
- What's the base rate of success for this type of action?
- What were the conditions when it succeeded vs failed?
- Does the current situation more closely resemble the successes or failures?

## Common Pattern Categories

### Political
- Foreign power promises to develop/protect a weaker nation
- Revolutionary movement promises transformation
- Leader consolidates power "temporarily" for stability
- Government blames external enemies for domestic failures

### Economic
- Resource-rich nation signs extraction deal with foreign power
- Government promises economic miracle through a single policy
- Currency peg/devaluation as solution to debt crisis
- "This bubble is different from the last one"

### Military
- Foreign military intervention to "stabilize" a region
- Arms deal framed as defensive alliance
- Proxy war escalation patterns
- Occupation presented as liberation

### Technology/Business
- Revolutionary product with no working prototype
- "Disruption" of a regulated industry
- Merger promising synergies and no layoffs
- Platform promising to remain neutral/open

## Output Format

```markdown
## Historical Parallel Analysis: [Current Event]

### Pattern Identified
[Structural pattern, abstracted from specifics]

### Historical Precedents

#### [Case 1: Name — Year]
- **What happened:** [Brief description]
- **Outcome:** [What actually resulted]
- **Key lesson:** [What this teaches]

#### [Case 2: Name — Year]
[Same structure]

### Comparison
| Factor | [Case 1] | [Case 2] | Current |
|--------|----------|----------|---------|
| [Factor] | [Then] | [Then] | [Now] |

### What's Different This Time
- [Genuine difference and whether it matters]

### Base Rate
[X out of Y similar cases resulted in Z]

### Assessment
[What history suggests will happen, with confidence level]
```

## Guidelines

- Always look for failures, not just successes — survivorship bias makes successes visible and failures invisible
- "This time is different" is almost never true at the structural level
- Include at least one case from a different region/culture to avoid geographic bias
- Note when historical actors had access to the same precedents and chose to ignore them
- Pair with mental-models (base rate, inversion) for deeper analysis
