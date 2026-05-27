---
name: news-query
category: output
compatibility: Designed for FlopsyBot agent
description: Output template for news-style answers. Use whenever the user asks for news, updates, or "what's happening" on any topic — surfaces 3 items with headline + take + URL, never a topic blob.
when-to-use: "Use BEFORE composing the reply, whenever a user message contains 'news', 'updates', 'what's new', 'what's happening', 'any news about', or asks for current developments on a topic. Loads the cited 3-item output template the user expects."
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# news-query — output template

When the user asks for news on any topic, the reply MUST follow this template.

## Trigger phrases
- "any news about X?"
- "news on X this week"
- "what's new in X?"
- "what's happening with X?"
- "updates on X?"
- "latest on X"

## The shape (mandatory)

Three items, each on its own line, each with three parts: headline — one-line take — URL.

```
📰 News on <topic>
  • <Headline> — <1-line take with the so-what>
    <https://full.url.com/path>
  • <Headline> — <1-line take>
    <https://full.url.com/path>
  • <Headline> — <1-line take>
    <https://full.url.com/path>
```

That's it. Three items, three URLs, three lines of "so what." No prose intro. No closing question like "want details on any?" — they can ask.

## Hard rules

1. **Every item MUST have a real URL.** If you got the item from web_search, copy the URL verbatim. No invented links. No `[source]` labels with empty parentheses.
2. **The take is the value, not the headline.** Don't just restate the title — say what changed, why it matters, who it affects in one phrase.
3. **Three items minimum, five maximum.** Below three: do another web_search with a different angle (recent / reactions / analysis). Above five: the user asked for *news*, not a digest — pick the top three.
4. **Topic per item — not topic per sentence.** Never write "CVEs X, Y, Z; AI debates A, B; harness updates C" all in one line. Each item is one story.
5. **Date the item when possible.** `Headline (3d ago)` or `Headline — Nov 21` is fine. Skip if not available.

## Anti-patterns — instant failure

These are the exact failure modes to avoid:

- ❌ `Found updates: CVEs Trend Micro Apex One InfoScale VIOM; AI LLM fine tuning debates; want details on any?`
  (multi-topic blob, no URLs, no per-item structure, trailing chatbot question)
- ❌ `Three news items: X, Y, Z. Source` (no URLs, "Source" label is meaningless without the link)
- ❌ Stripping URLs to "avoid Telegram markdown escaping" — channel handles escaping; you output plain `https://...`
- ❌ Hedging: "I found some news but you might want to verify..." Just give the three with URLs and the user verifies via clicking.

## Multi-topic handling

If the user names multiple topics ("any news about X, Y, and Z") or has multiple memorized interests:

- **Don't** cram all topics into one section.
- **Do** pick the top 2 topics with the most relevant news, give 3 items each (so 6 total), then add at the end: `Skipped: <topic A>, <topic B> — say "expand" to dig into either.`

## Example — strong

> User: "any news on AI agents this week?"
>
> ```
> 📰 AI agents this week
>   • Anthropic ships Sonnet 4.5 with native MCP — first frontier model with the protocol built into the API; lowers the bar for tool-using agents
>     https://www.anthropic.com/news/sonnet-4-5
>   • OpenAI deprecates 4o fine-tuning API for new models — pushes everyone toward prompt + RAG; "year of small models" thesis takes a hit
>     https://platform.openai.com/docs/deprecations
>   • Hermes-Agent overtakes OpenClaw on OpenRouter token volume — fastest-growing open-source agent project this quarter
>     https://github.com/NousResearch/hermes-agent
> ```

## Example — weak (do not do)

> ❌ `Found updates: Anthropic Sonnet 4.5 MCP, OpenAI deprecation, Hermes growth; want details on any?`

The same three facts, mashed into one sentence with no URLs, no takes, no shape. That's the failure mode this skill exists to prevent.
