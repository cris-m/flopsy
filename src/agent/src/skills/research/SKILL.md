---
name: research
compatibility: Designed for FlopsyBot agent
description: Deep research methodology with multi-query strategy. Use when gathering comprehensive information on any topic.
---

# Research Skill

Comprehensive research methodology for gathering thorough, accurate information.

## When to Use This Skill

Use this skill when the user asks:
- "What's new in [topic]?"
- "Research [subject] for me"
- "Find information about [topic]"
- "What should I know about [topic]?"
- "Any news about [topic]?"
- Questions requiring current, comprehensive information



## Core Principle: Multi-Query Research

**NEVER do just one search.** A single query misses important angles.

### Minimum Queries by Topic Type

| Topic Type | Minimum Searches | Query Angles |
|------------|------------------|--------------|
| News/Updates | 4-6 | Recent news, announcements, reactions, analysis |
| Technical | 3-5 | Docs, tutorials, Stack Overflow, GitHub |
| Company/Product | 4-6 | Official, news, reviews, competitors |
| Person | 3-4 | Bio, recent work, interviews, social |
| Concept | 3-4 | Definition, examples, comparisons, tutorials |



## Research Process

### Step 1: Query Planning (REQUIRED)

Before searching, **plan your queries explicitly**:

```
Topic: "AI news from past 2 weeks"

Planned Queries:
1. "AI news January 2025" (general news)
2. "new AI models released 2025" (model releases)
3. "OpenAI Anthropic Google AI announcements 2025" (major labs)
4. "DeepSeek Qwen AI China models 2025" (Chinese labs)
5. "AI capabilities breakthrough 2025" (technical advances)
6. "open source AI models 2025" (open source)
```

### Step 2: Execute Searches

Run **multiple searches in parallel** when possible:

```
Search 1: "AI news January 2025"
Search 2: "new AI models released January 2025"
Search 3: "OpenAI Anthropic announcements January 2025"
...
```

### Step 3: Assess Sources (source-assessment skill)

For each result you plan to cite, run a quick credibility and manipulation check:
- Is the source credible? (named author, established outlet, dated, cited)
- Any manipulation patterns? (urgency, FUD, false authority, us-vs-them)
- Prioritize clean sources. Flag or drop suspect ones.

See the **source-assessment** skill for the full assessment framework.

### Step 4: Deep Dive on Important Results

For significant findings, use `web_extract` to get full content:

```
Found: "DeepSeek releases R2 reasoning model"
→ Extract full article for details
→ Look for benchmarks, capabilities, pricing
```

### Step 5: Cross-Reference

Verify important claims across multiple sources:

```
Claim: "Model X beats GPT-4 on MMLU"
→ Check original source
→ Check independent benchmarks
→ Note if contested or confirmed
```

### Step 6: Synthesize

Combine findings into structured response with sources.



## Query Strategies by Topic

### AI/Tech News Research

```
Query Set:
1. "[topic] news [month] [year]"
2. "[topic] announcements [year]"
3. "[major companies] [topic] [year]"
4. "[topic] release launch [year]"
5. "[topic] breakthrough advances [year]"
6. "open source [topic] [year]"

Example for "AI news past 2 weeks":
1. "AI news January 2025"
2. "AI model releases January 2025"
3. "OpenAI Anthropic Google DeepMind announcements January 2025"
4. "DeepSeek Alibaba Qwen AI January 2025"
5. "AI capabilities reasoning multimodal January 2025"
6. "open source LLM releases January 2025"
```

### Company Research

```
Query Set:
1. "[company] news [year]"
2. "[company] products announcements"
3. "[company] reviews ratings"
4. "[company] vs competitors"
5. "[company] funding valuation" (if startup)
```

### Technical Research

```
Query Set:
1. "[technology] documentation"
2. "[technology] tutorial guide"
3. "[technology] examples GitHub"
4. "[technology] best practices"
5. "[technology] vs alternatives"
```

### Person Research

```
Query Set:
1. "[name] bio background"
2. "[name] recent work projects"
3. "[name] interviews talks"
4. "[name] [company/field]"
```



## Output Format

### For News/Updates Research

```markdown
## Summary
[2-3 sentence overview of key developments]

## Major Developments

### [Development 1 Title]
- **What:** [Description]
- **Who:** [Company/People involved]
- **When:** [Date]
- **Why it matters:** [Significance]
- **Source:** [URL]

### [Development 2 Title]
...

## Quick Hits
- [Smaller news item 1] ([Source](url))
- [Smaller news item 2] ([Source](url))

## Sources
- [Source 1](url)
- [Source 2](url)
...
```

### For Technical Research

```markdown
## Summary
[Direct answer to question]

## Key Findings
- Finding 1 ([Source](url))
- Finding 2 ([Source](url))

## Details
[Deeper explanation with examples]

## Sources
- [Source 1](url)
- [Source 2](url)
```



## Proactive Behaviors

### Always Do:
- [ ] Plan multiple queries before searching
- [ ] Search at least 3 different angles
- [ ] Extract full content for important findings
- [ ] Cross-reference significant claims
- [ ] Include dates for time-sensitive info
- [ ] Cite every fact with source URL
- [ ] Note confidence level (high/medium/low)

### If Asked About Recent Events:
- [ ] Include specific date range in queries
- [ ] Check multiple news sources
- [ ] Look for official announcements
- [ ] Check social media/forums for reactions

### If Answer Seems Incomplete:
- [ ] Do additional targeted searches
- [ ] Try different query phrasings
- [ ] Search in specific domains (site:github.com, site:arxiv.org)



## Common Mistakes to Avoid

| Mistake | Problem | Solution |
|---------|---------|----------|
| Single search | Misses angles | Plan 3-6 queries minimum |
| Vague queries | Poor results | Be specific with dates, names |
| No sources | Unverifiable | Cite every fact |
| No dates | Outdated info | Include time range in query |
| Surface only | Missing depth | Extract full articles |
| Echo chamber | Bias | Use diverse sources |



## Integration with Tools

### web_search
```
Use for: Initial discovery, multiple angles
Queries: 3-6 per research topic
```

### web_extract
```
Use for: Full article content, details
When: Important findings need more context
```

### http_request
```
Use for: APIs, structured data
Examples: GitHub API, news APIs
```
