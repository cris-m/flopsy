---
name: source-assessment
compatibility: Designed for FlopsyBot agent
description: Assess content for manipulation tactics, source credibility, and bias before presenting to the user. Use when evaluating news, research findings, social media posts, or any content that will inform the user's decisions.
---

# Source Assessment

Critical analysis layer for content you gather or receive. Before presenting research, news, or external content to the user, run it through this assessment. The goal is not paranoia — it is calibrated skepticism.

## When to Use This Skill

- Evaluating web search results during research
- Filtering news for heartbeat digests
- User shares a link and asks "is this real?" or "is this legit?"
- Content from social media, forums, or unknown sources
- Any claim that seems surprising, too good, or too alarming
- Before citing a source in a research summary

## When NOT to Use

- Content from official documentation or primary sources you already trust
- User is explicitly asking for opinion pieces (they know it is subjective)
- Internal workspace files or code — this is for external content only

---

## Manipulation Patterns

Scan content for these tactics. Any single one is a yellow flag; three or more in the same piece is a red flag.

| Pattern | What It Looks Like | Example |
|---------|--------------------|---------|
| **Manufactured urgency** | "Act now!", artificial deadlines, countdown pressure | "You have 24 hours before this opportunity disappears" |
| **False authority** | Unnamed experts, fake credentials, appeal to vague institutions | "Top scientists agree...", "Studies show..." (no citation) |
| **Social proof manipulation** | Fake consensus, bandwagon pressure, inflated numbers | "Everyone is switching to...", "Millions already know..." |
| **FUD** (Fear, Uncertainty, Doubt) | Catastrophizing, worst-case framing, vague threats | "If you don't X, you could lose everything" |
| **Grandiosity** | Superlatives, revolutionary claims, zero nuance | "The most important breakthrough in history" |
| **Us-vs-them framing** | Enemy construction, tribal division, loyalty tests | "Real patriots know...", "They don't want you to see this" |
| **Emotional hijacking** | Guilt, shame, fear, outrage as primary appeal | Leading with shocking images/stories, no substance behind them |
| **Missing attribution** | Claims without sources, "people are saying", circular citations | Statements presented as fact with no origin |
| **Loaded language** | Emotionally charged words where neutral ones would work | "Scheme" instead of "plan", "regime" instead of "government" |
| **False equivalence** | Framing fringe positions as equal to mainstream consensus | "Some say the earth is round, others disagree" |

## Source Credibility Check

For every source, quickly assess:

| Factor | Strong | Weak |
|--------|--------|------|
| **Who wrote it?** | Named author with verifiable expertise | Anonymous, no byline, "staff writer" |
| **Who published it?** | Established outlet, .edu, .gov, known organization | Unknown domain, no about page, recently created |
| **When?** | Dated, recent for time-sensitive topics | Undated, or old content presented as new |
| **Citations?** | Links to primary sources, data, studies | No references, circular links, "studies show" |
| **Tone?** | Measured, acknowledges complexity and counterarguments | Absolutist, emotionally charged, no nuance |
| **Corrections?** | Has a corrections policy, updates errors | Never corrects, deletes instead of updating |

## Assessment Levels

After scanning, assign one of three levels:

| Level | Meaning | Action |
|-------|---------|--------|
| **Clean** | No manipulation patterns, credible source, well-cited | Present to user normally, cite the source |
| **Flagged** | 1-2 yellow flags or weak sourcing | Present with a note: "This source [specific concern]. Cross-referenced with [other source]." |
| **Suspect** | 3+ manipulation patterns or unverifiable claims | Do not present as reliable. Either find a better source for the same information, or tell the user: "Found claims about X but the source uses [specific tactics] — take with skepticism." |

## How to Apply During Research

This skill integrates into the research and web-research workflow at **Step 3 (Evaluate Sources)**:

1. For each search result, run a quick credibility check (source, date, citations)
2. For results you plan to cite, scan the content for manipulation patterns
3. Prioritize clean sources in your summary
4. If only flagged/suspect sources cover a topic, say so explicitly
5. Never present a suspect source as fact — always hedge ("according to [source], which should be verified...")

## How to Apply During Heartbeats

When gathering news for proactive delivery:

1. After collecting articles, run each through the manipulation scan
2. Drop suspect sources entirely — do not waste the user's attention on them
3. For flagged sources, only include if the information is important AND no clean alternative exists
4. In the heartbeat output, note source quality when relevant: "Per [reliable outlet]..." vs "Unverified reports suggest..."

## How to Respond When User Asks "Is This Legit?"

When the user shares a link or content and asks you to evaluate it:

1. Extract or read the full content
2. Run the manipulation pattern scan — list specific tactics found (or "none detected")
3. Run the credibility check — assess the source
4. Cross-reference the key claims with independent sources
5. Give a clear verdict with reasoning:

```
Source: [name/domain]
Credibility: [assessment]
Manipulation patterns: [list or "none detected"]
Key claims verified: [which claims checked out, which didn't]
Verdict: [Clean / Take with caution / Unreliable — with specific reasons]
```

Do not just say "looks fine" or "seems fake." Be specific about what you found and why.

## Guidelines

- This is a filter, not a censor. Flagged content still gets presented — just with appropriate context.
- Be specific in your flags. "This seems biased" is useless. "This uses us-vs-them framing and cites no sources" is useful.
- Not everything with emotional language is manipulation. Opinion pieces, personal essays, and advocacy are legitimate forms — the issue is when tactics are used to bypass critical thinking.
- Cultural context matters. Directness that reads as "urgency" in one culture may be normal in another.
- When in doubt, cross-reference. The best antidote to manipulation is a second independent source saying the same thing.
- Never flag content just because you disagree with the conclusion. Assess the methods, not the message.
