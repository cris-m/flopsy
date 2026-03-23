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