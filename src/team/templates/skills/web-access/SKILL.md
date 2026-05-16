---
name: web-access
description: Pick the right tool for getting content off the web. `web_search` for "find me X", `web_extract` for "read this URL", `http_request` for JSON APIs, `web_crawl` for a whole site, `browser` for JS-heavy SPAs. Delegate to `legolas` for short hops, `spawn_background_task("saruman", ...)` for deep multi-source briefs.
metadata:
  flopsy:
    agent-affinity: [gandalf, legolas, saruman]
---

# Web access

Four tools for direct web work, plus delegation patterns when the work is bigger than one tool.

## Pick by shape

| You need | Use |
|---|---|
| Top results for a query | `web_search({ query, maxResults })` |
| Read one specific URL as clean markdown | `web_extract({ url })` |
| Hit a JSON / REST endpoint | `http_request({ url, method, headers?, body? })` |
| Crawl multiple pages from one domain | `web_crawl({ startUrl, maxPages? })` |
| Read a SPA / login-walled / JS-heavy page | `browser` MCP (`browser_navigate`, `browser_get_text`, etc.) |

Real schemas (verified against `flopsygraph/src/prebuilt/tools/web-search.ts`, `web-extract.ts`, `http-request.ts`, `web-crawl.ts`):

```
web_search({ query: "anthropic claude opus 4.7 release", maxResults: 10 })

web_extract({ url: "https://www.anthropic.com/news/some-post" })

http_request({
  url: "https://api.example.com/v1/things",
  method: "GET",
  headers: { "Authorization": "Bearer ..." }
})

web_crawl({ startUrl: "https://docs.example.com", maxPages: 20 })
```

## Backend priority (transparent to you)

- `web_search`: Firecrawl → Tavily → DuckDuckGo (auto-fallback)
- `web_extract`: Firecrawl → Tavily
- `web_crawl`: Firecrawl-only (lazy-loaded from research bundle)

You don't pick the backend. If one is unavailable, the tool falls back automatically.

## When to use the `browser` MCP

The `browser` MCP runs a real Playwright session — slower, but reads pages `web_extract` can't:

- Single-page apps where the content is rendered via JS
- Login-walled or paywalled pages where you have a session
- Pages that detect scrapers and serve a stub to `web_extract`

Common verbs: `browser_navigate`, `browser_get_text`, `browser_click`, `browser_screenshot`. Load them via `__load_tool__({"query":"browser"})` if not already attached.

The `browser` MCP is `assignTo: ["gandalf", "legolas", "saruman"]`. `gimli`, `aragorn`, `sam` cannot use it directly.

## When to delegate instead of doing it yourself

If you are gandalf and you're about to fire `web_search` or `web_extract` for the user, ask: would `legolas` do this better?

- Short one-shot lookups → just do it yourself or `delegate_task("legolas", ...)`. Either works.
- Multi-source brief with citations → `spawn_background_task("saruman", "...")`. Don't block the user for ten minutes waiting for saruman.
- Three or more parallel searches → fan out via three `delegate_task("legolas", ...)` calls in one turn.

```
// "Compare Anthropic / OpenAI / Google's stance on AI safety, with sources."
spawn_background_task({
  worker: "saruman",
  task: "Brief comparing AI safety positions of Anthropic, OpenAI, and Google in 2026. Include official policy docs, recent blog posts, and any public commitments. 1.5 pages with citations."
})
```

## URL routing cheatsheet

| URL pattern | Best tool |
|---|---|
| `x.com` / `twitter.com` | `twitter_extract` (load via `__load_tool__({"query":"twitter"})`) — DON'T `web_extract` X/Twitter, the scrape is unreliable |
| `youtube.com` / `youtu.be` | `youtube` MCP tools (load via `__load_tool__({"query":"youtube"})`) for transcripts and video metadata. Assigned to `legolas`. |
| GitHub PR / issue / file | `github` MCP tools |
| Plain JSON API endpoint | `http_request` |
| Docs / blog / news article | `web_extract` |
| Heavily-rendered SPA | `browser` |
| News query without a specific URL | `web_search` (or `news` tool if attached) |

## Common mistakes

- **Using `web_search` when you have the URL.** If you already have the link, go straight to `web_extract`.
- **Using `web_extract` on X/Twitter or a SPA.** It scrapes the rendered-HTML stub; you'll miss the actual content. Use `twitter_extract` or `browser`.
- **Forgetting the dynamic catalog.** `twitter_extract`, `youtube_*`, `gmail_*`, `calendar_*`, `drive_*` aren't pre-attached. Load with `__load_tool__({"query":"twitter"})` etc.
- **Doing five sequential `web_search` calls in five turns.** Fan out in one turn — five `delegate_task("legolas", ...)` calls run in parallel.
