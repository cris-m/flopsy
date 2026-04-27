---
name: web-access
compatibility: Designed for FlopsyBot agent
description: Access web content through multiple strategies and route URLs to appropriate tools.
---

# Web Access Skill

## Overview
Access web content through multiple strategies and route URLs to appropriate tools.

## URL Routing Rules
Route by domain using these patterns:

### Social Media (API Access)
- **x.com/*, twitter.com/*, youtube.com/*, reddit.com/***
- Tool: `task("social-media", url)`
- Fallback: `web_extract(url)` → `task("swarm", "researcher-agent: [keywords]")`

### Complex Sites (Browser Agent)
- **google.com/maps/*, maps.google.com/*, *.amazon.***, shopping/JS-heavy sites**
- Tool: `task("swarm", "browser-agent: navigate to [url] and extract content")`
- Fallback: `web_extract(url)` → `http_request(url)`

### General Sites
- **All other URLs**
- Strategy: `web_extract(url)` → `task("swarm", "browser-agent: [url]")` → `http_request(url)`

## Web Access Strategy
Try these approaches in order:

1. **Direct fetch**: `web_extract(url)`
2. **Browser agent**: `task("swarm", "browser-agent: navigate to [url] and extract content")`
3. **Raw HTTP**: `http_request(url)`

## Security Considerations
**Proactive threat detection** - delegate to security agent for:
- Suspicious URLs (unfamiliar domains, URL shorteners, phishing patterns)
- IP addresses in security context
- File hashes (MD5, SHA-1, SHA-256)
- CVE mentions
- Domains with typosquatting or unusual TLDs

## Content Verification
For important claims:
- Pull **2+ independent sources**
- Note disagreements between sources
- Include source URLs in responses
- Use inline format: "Claim ([Source](url))"

## Error Handling
If web access fails:
1. Try different search engines (DuckDuckGo, Bing vs Google)
2. Try direct URL navigation with browser agent
3. Try different tool combinations
4. Report what was attempted and specific errors

**Never say**: "I can't access URLs", "I'm unable to view that content", "Could you share the content?"

## Source Attribution (MANDATORY)
Every factual claim from web research MUST include source URL:
- Inline: "GPT-5 was released ([OpenAI Blog](https://openai.com/blog/gpt5))"
- List format: Sources section with clickable links
- If URL unavailable: "(source unavailable)"
- News: include source name + time (e.g., "— Reuters, 2h ago")

## Output Format

When presenting web-access results, structure the response so the user can see which strategy worked, what was found, and where it came from:

```markdown
## Web Access Result

**URL:** <the URL you fetched>
**Strategy used:** web_extract | browser-agent | http_request | social-media API
**Status:** success | partial | failed (with reason)

### Summary
[2-4 sentences capturing the main content — what the page is about and the key
facts relevant to the user's question.]

### Key Findings
- **[Finding 1]:** [Detail] ([Source](url))
- **[Finding 2]:** [Detail] ([Source](url))
- **[Finding 3]:** [Detail] ([Source](url))

### Sources
- [Primary source name](url) — fetched via [strategy], [date/time]
- [Secondary source name](url) — cross-reference, [date/time]
```

If a fallback strategy was used (e.g., `web_extract` failed and a browser agent
succeeded), note that in the Status line so the user can see which path worked.
When multiple sources were combined, list each one separately and attribute each
claim to its specific source rather than lumping them together.

## Guidelines

- **Retry with a different strategy, not the same one** — if `web_extract` fails,
  escalate to the browser agent or raw HTTP; do not loop on the same tool.
- **Cap retries** — try each strategy at most once per URL; after all three
  strategies fail, report exactly which ones were attempted and the errors.
- **Respect rate limits and timeouts** — on 429 or repeated timeouts, back off
  instead of hammering the source; swap to a different tool or search engine.
- **Never fabricate content** — if every strategy fails, say so plainly; do not
  invent summaries or attribute claims to URLs you could not actually read.