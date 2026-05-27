---
name: cited-reply
category: output
compatibility: Designed for FlopsyBot agent
description: Default output discipline for any reply whose content came from a tool. Use whenever web_search, web_extract, web_research, news, http_request, or any external source informed the answer — enforces inline URL citation and synthesis-not-dump.
when-to-use: "Use BEFORE composing the final reply whenever the response is informed by web_search / web_extract / web_research / news / http_request / any tool that returned external content. Loads the citation-required template that prevents 'I found stuff' replies without links."
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# cited-reply — output discipline for tool-sourced answers

When ANY part of the reply came from a web tool, this template applies.

## When this skill activates
Read this BEFORE composing the reply if you used any of these tools in this turn:
- `web_search`
- `web_extract`
- `web_research`
- `news`
- `http_request` (to a URL returning text)
- Any tool whose output you're paraphrasing in the reply

If you only used internal tools (`time`, `memory`, `calendar`, `read_file`), this skill does not apply.

## The two non-negotiable rules

**Rule 1 — Every external claim carries its URL inline.**

A fact you read on the web does not exist in your reply unless its source URL is right next to it. If you found it via `web_search`, you have the URL — paste it. If you can't find the URL, you can't make the claim.

**Rule 2 — Synthesize, don't dump.**

The tool returned 1000-5000 chars of search results. You return 3-12 well-formed lines. The user wants what changed and what to do, not the raw HTML of the SERP.

## The two output shapes

### Shape A — fact-style (single answer)

```
<the answer in 1-3 sentences, with the source URL inline or right after>

Source: <https://full.url>
```

Use when the user asked a single factual question ("when was X released", "what's the CVE for X", "who is X").

### Shape B — list-style (multiple items)

```
<one-line orienting summary if needed, else skip>

  • <item 1 take> — <https://url1>
  • <item 2 take> — <https://url2>
  • <item 3 take> — <https://url3>
```

Use when the user asked for *multiple* things ("3 options", "top X", "news on", "compare").

For news specifically, prefer the `news-query` skill — it has the richer 3-item template.

## Hard prohibitions

These are recurring failure modes — never do them:

1. ❌ **The orphan "Source"** — writing the word "Source" at the end of a reply without a URL after it. Either include the URL or drop the word entirely.
2. ❌ **The escape-paranoia strip** — removing URLs because "I might need to escape parentheses for Telegram MarkdownV2." The channel layer escapes formatting; you output plain `https://...` URLs and they work.
3. ❌ **The "I found some info" preamble** — no "Based on my search...", "Looking at the latest...", "I found that...". Start with the answer.
4. ❌ **Inventing dates / bulletins** — if you don't have a URL for a "Trend Micro released a bulletin on May 21," you don't have the bulletin. Drop the claim.
5. ❌ **Citing the search engine, not the page** — `Source: google.com/search?q=...` is not a citation. The citation is the destination page URL.

## Inline URL format

Plain URL is preferred over markdown link syntax — it works on every channel:

```
✓ "Anthropic shipped Sonnet 4.5 today — https://www.anthropic.com/news/sonnet-4-5"
✓ "  • Sonnet 4.5 shipped — https://www.anthropic.com/news/sonnet-4-5"
✗ "Anthropic shipped Sonnet 4.5 today [news](https://...)"  ← may not render
✗ "Anthropic shipped Sonnet 4.5 today. Source"             ← no URL
```

If markdown links work on the channel (you can see `MarkdownV2` in `<runtime>` capabilities), `[name](url)` is also fine — but never the broken form `[name]( url)` with a stray space, and never `[name]()` empty.

## Confidence markers

If the tool returned the answer cleanly — plain prose, no marker. If you inferred the answer from indirect evidence in the tool result — append `(unsourced)` to the claim. If you couldn't find the URL — drop the claim entirely.

## Examples

### Strong — fact-style with citation

> User: "what's CVE-2026-34926?"
>
> ```
> CVE-2026-34926 is a directory-traversal vulnerability in Trend Micro Apex One (on-premise) that lets a pre-authenticated local attacker modify a key table. Patched in the May 2026 security bulletin.
>
> Source: https://www.cisa.gov/news-events/cybersecurity-advisories/aa26-141a
> ```

### Strong — list-style with citations

> User: "what are the top frontier model APIs right now?"
>
> ```
>   • Anthropic Claude 4.5 — best at long context + code — https://www.anthropic.com/api
>   • OpenAI GPT-5.5 — strongest reasoning + multimodal — https://openai.com/api
>   • Google Gemini 2.5 Pro — cheap + 2M context — https://ai.google.dev
> ```

### Weak — do not do

> ❌ `I found some info on CVE-2026-34926. It's about Trend Micro Apex One. Source` — vague preamble, "Source" with no URL.
> ❌ `Top APIs: Anthropic, OpenAI, Google; want details on any?` — no URLs, no takes, trailing chatbot question.

This skill exists to prevent both.
