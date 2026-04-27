---
name: last30days
description: Pull a user's last 30 days of public activity across X/Twitter, Reddit, and Hacker News without any paid API keys. Returns newest-first with date, body, engagement, and URL. Designed for daily digests, "catch me up on @user" workflows, and feeding Obsidian/Notion digests from cron jobs.
compatibility: Designed for FlopsyBot agent
---

# last30days — 30-day activity snapshot

Fetches recent public activity across X/Twitter, Reddit, and Hacker News for a single user. No paid API keys required — X reuses the cookie-based `twitter` MCP you already have; Reddit and HN are pure public HTTP.

## When to use

- "What has @user been up to this month?"
- "Summarize my own X activity from the last 30 days"
- Daily/weekly digest cron jobs feeding Obsidian / Notion / a channel

## Platforms

| Platform | Technique | Auth |
|----------|-----------|------|
| X / Twitter | `twitter_user_tweets` MCP tool (cookie-based) | reuses `twitter` skill's auth recovery |
| Reddit | `http_request` → `https://www.reddit.com/user/<name>.json` | none |
| Hacker News | `http_request` → `hacker-news.firebaseio.com/v0/user/<id>.json` then `/item/<id>.json` per submission | none |
| TikTok | Out of scope — fingerprinted and login-walled | — |
| Instagram | Out of scope — needs logged-in session | — |

## Workflow — single user, single platform

### X / Twitter
1. `twitter_user_tweets` with `username` + a generous count (e.g. 100, newest first)
2. Filter client-side to `created_at >= now - 30d`
3. Keep per tweet: timestamp, text, `likes + retweets + replies`, URL
4. If the MCP errors, fall through the recovery chain from the `twitter` skill (bird CLI → web_search)

### Reddit (no auth)
1. `http_request` GET `https://www.reddit.com/user/<name>.json?limit=100`
   - Add header `User-Agent: flopsybot/1.0 (contact: <your-email>)` — Reddit rate-limits anonymous / default UAs
2. Parse `.data.children[]`, filter where `data.created_utc >= (Date.now()/1000 - 30*86400)`
3. Per item keep: `kind` (`t1` = comment, `t3` = post), `data.permalink`, `data.title || data.body`, `data.score`, `data.subreddit`, `data.created_utc`
4. If you need > 100 items, paginate with `after=<fullname>` until you cross the 30-day boundary

### Hacker News (no auth, no limits but chatty)
1. `http_request` GET `https://hacker-news.firebaseio.com/v0/user/<id>.json` → read `.submitted` (array of item ids, newest first)
2. Walk ids from the start; for each `http_request` GET `/v0/item/<id>.json`
3. Stop once `item.time < (Date.now()/1000 - 30*86400)`
4. Per item keep: `type`, `title || text`, `score`, `descendants`, `time`, URL = `https://news.ycombinator.com/item?id=<id>`

## Output shape

Always return standard markdown — other skills (obsidian, memory) can consume it:

```
## @{user} — last 30 days

### X/Twitter (N posts)
- [YYYY-MM-DD] 💬 replies · ♻️ RTs · ❤️ likes — <body excerpt>
  → <url>

### Reddit (M items)
- [YYYY-MM-DD] r/<sub> (<score> pts) — <title or first line of body>
  → <url>

### Hacker News (K submissions)
- [YYYY-MM-DD] <points> pts · <comments> comments — <title>
  → <url>

## Highlights
(3–5 bullet synthesis across platforms, picked by engagement or topical signal)
```

## Daily digest cron pattern

Add a job to `flopsy.json5` under `proactive.scheduler.jobs`:

```json5
{
    "name": "x-reddit-hn-digest",
    "enabled": true,
    "schedule": "0 7 * * *",
    "message": "Run the last30days skill for @<target-user>. Summarize top 5 items by engagement. Save to Obsidian at 'Daily/30d-<target-user>-{{ date }}.md' and send the highlights section to <channel>.",
    "deliveryMode": "silent"
}
```

The scheduler hands the message to gandalf; gandalf reads this SKILL.md, executes the workflow, and uses `obsidian_create` + `send_message` (or whichever channel tools are assigned).

## Caching (optional but recommended)

For chatty endpoints (HN), cache per-item responses so repeated runs don't refetch:
- Path: `workspace.cache('last30days/hn-<itemId>.json')`
- TTL: 7 days for items (stable once posted); 1 hour for the user index
- Use `read_file` → parse → fallback to `http_request` on miss

## Date math helper

Unix seconds for "30 days ago":
```
cutoff_sec = Math.floor(Date.now() / 1000) - 30 * 86400
```
Reddit uses `created_utc` in seconds, HN uses `time` in seconds, X returns ISO strings — parse with `Date.parse()`.

## Limitations

- No API → no recovery of deleted content
- Reddit anonymous JSON caps at ~1000 items total; prolific accounts need pagination
- HN public API is unrate-limited but chatty — one HTTP request per item
- TikTok/Instagram require session cookies and active fingerprint management — build those as separate skills if needed
- Reddit may return `429` or empty for default User-Agents — always set a custom UA
