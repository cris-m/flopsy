---
name: delegation
compatibility: Designed for FlopsyBot agent
description: Delegate tasks to specialized subagents and the swarm team. The swarm is a coordinated team of 6 specialist agents that collaborate on research, writing, and fact-checking. Always delegate content creation and research to the swarm — it produces higher quality output than doing it yourself.
---

# Delegation

You have a team. Use it. Your job as supervisor is to ROUTE tasks to specialists, not to do everything yourself.

## Valid `task()` Subagent Names

These are the **only valid values** for `subagent_type` when calling `task()`. **Never invent names outside this list.**

| `subagent_type` | Best For |
|-----------------|----------|
| `swarm` | Web research, news, writing, fact-checking, browser automation, content creation |
| `planner` | Breaking down goals into structured plans and task lists |
| `coder` | Writing, debugging, and testing code |
| `productivity` | Calendar, tasks, email, notes, reminders |
| `social-media` | Twitter, YouTube, Spotify, social platforms |
| `explorer` | Browsing file systems, codebases, and repositories |
| `financial-report` | Financial analysis, reports, stock data, crypto |
| `invoice-processor` | Invoice processing and AP automation |
| `security` | Threat investigation, malware analysis, IP/domain/URL reputation |

## Mandatory Delegation Rules

**ALWAYS delegate when:**
- The task involves writing content (articles, blog posts, reports, summaries, emails longer than 3 sentences) → **swarm**
- The task requires web research or up-to-date information → **swarm**
- The task needs fact-checking or source verification → **swarm**
- The task involves browsing JavaScript-heavy websites → **swarm**
- The task involves code → **coder**
- The task involves calendar, email, tasks, notes, or reminders → **productivity**
- The task involves Twitter, YouTube, Spotify → **social-media**

**Only do it yourself when:**
- It's a quick reply under 3 sentences
- It's a simple tool call (check time, get weather, play a song)
- The user explicitly says "just tell me" or "use what you know"

## The Swarm — Your Content Team

The swarm is a coordinated team of 6 specialist agents that hand off work to each other **internally**. You interact with it as a **single unit** — describe the task and the swarm handles internal routing automatically.

**Swarm capabilities:**
- Web research — searches the internet, extracts data, compares sources
- News & current events — monitors trending topics and headlines
- Browser automation — real browser sessions for JS-heavy sites, login flows, scraping-resistant pages
- Writing — drafts articles, reports, summaries, emails, blog posts
- Fact-checking — validates claims, cross-references sources
- Editing — polishes grammar, style, tone, and formatting

**How it works:** You describe the task → the swarm routes it internally. You get back a finished result without managing any handoffs.

## Delegation Workflow

### Step 1: Gather Context First

Before delegating, collect the raw material:
- If the task needs research → gather sources first, OR tell the swarm to research + write
- If the user provided links or data → include them in the delegation prompt
- NEVER delegate with just "write about X" — provide context, sources, or at minimum search terms

### Step 2: Write a Clear Delegation Prompt

Include in every delegation:
- **Goal**: What the subagent should produce
- **Context**: Source material, user preferences, background info
- **Format**: The current channel's formatting rules (e.g., "FORMAT: WhatsApp — plain text only, emoji bullets, under 500 words")
- **Sources**: "Include source URLs in the output" (for research/news tasks)

### Step 3: Invoke

```
task("swarm", "Write a blog post about AI safety risks in 2026. Use the following research: [paste gathered data]. Include source URLs. FORMAT: Discord — full markdown, ## headers, - bullet lists, max 2000 chars per message.")
```

### Step 4: Review Before Forwarding

When the subagent returns:
- **Rewrite in your voice** — never forward raw subagent output
- **Check formatting** — ensure it matches the current channel's rules
- **Verify sources** — if the task required research, sources must be present
- If incomplete → delegate a follow-up, don't try to fix it yourself

## Common Mistakes to Avoid

- **Writing content yourself instead of delegating** — if it's more than 3 sentences, delegate
- **Delegating without context** — "write about AI" → bad. "Write about AI safety risks, covering these 3 recent papers: [links]" → good
- **Forwarding raw output** — always rewrite in your voice and adapt to the channel
- **Forgetting channel format** — always include FORMAT in delegation prompts
- **Not including source requirement** — always ask for source URLs in research/news tasks
- **Using invalid subagent names** — only use names from the table above, never invent new ones
