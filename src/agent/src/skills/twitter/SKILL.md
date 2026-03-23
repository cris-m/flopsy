---
name: twitter
compatibility: Designed for FlopsyBot agent
description: Post tweets, read timelines, search X/Twitter, and manage follows. Includes auth recovery via browser cookie import and rate limit handling with automatic retry.
---

# Twitter (X)

Interact with X (formerly Twitter) to post, read, search, and engage via MCP tools. Uses the `bird` CLI under the hood with browser-based cookie auth.

## Recovery Chain

**CRITICAL: Follow this order on ANY failure. Do NOT stop at step 1.**

1. **MCP tool** (e.g., `twitter_search`) — try the native tool first
2. **Re-auth** — if auth/cookie error, the MCP server auto-opens the browser for login and polls for 2 minutes. If it times out, try manual cookie refresh:
   ```
   execute("npx --yes @steipete/bird check")  # verify auth state
   ```
3. **`execute("npx --yes @steipete/bird <command> --json")`** — CLI fallback
4. **`web_search`** — for reading tweets/profiles when API tools are down (search "site:x.com username" or "site:twitter.com topic")
5. **Report failure** — ONLY after exhausting steps 1-4. State exactly which steps were tried

**Rate limit (429)**: Do NOT retry in a loop. Wait 2-3 minutes, then retry once. If still rate-limited, use `web_search` as read-only fallback.

**Empty results**: If search/timeline returns empty but you expect results, try `web_search` as fallback — the API may be throttled silently.

## Authentication Recovery

The MCP server handles auth automatically on startup:
1. Checks if `bird` CLI is installed (`npx @steipete/bird --version`)
2. Verifies authentication (`bird check` — looks for "Ready to tweet")
3. If not authenticated, opens `x.com/login` in the browser and polls every 5s for up to 2 minutes

**If auth fails during a session:**
```
execute("npx --yes @steipete/bird check")     # check current state
```
If it reports not authenticated, tell the user: "Please log in to X/Twitter in your browser. I'll detect it automatically." The `bird` CLI extracts cookies from Chrome, Arc, Firefox, and Safari.

## Tools — Complete Inventory (18 tools)

### Reading

| Tool | Purpose |
|------|---------|
| `twitter_read` | Read a specific tweet by URL or ID |
| `twitter_thread` | Read a full conversation thread |
| `twitter_replies` | Get replies to a tweet (with count) |
| `twitter_home` | Home timeline — "For You" (default) or "Following" (pass `following: true`) |
| `twitter_mentions` | Tweets mentioning you or another user |
| `twitter_user_tweets` | Get a specific user's tweets |
| `twitter_search` | Search tweets (supports Twitter search operators) |
| `twitter_news` | Trending news/topics (categories: all, ai, sports) |

### Writing

| Tool | Purpose |
|------|---------|
| `twitter_tweet` | Post a new tweet (280 char limit, optional media attachment) |
| `twitter_reply` | Reply to a specific tweet by URL/ID |

### Social

| Tool | Purpose |
|------|---------|
| `twitter_follow` | Follow a user |
| `twitter_unfollow` | Unfollow a user |
| `twitter_following` | List who a user follows |
| `twitter_followers` | List a user's followers |

### Account & Bookmarks

| Tool | Purpose |
|------|---------|
| `twitter_whoami` | Info about the authenticated account |
| `twitter_about` | Info about any Twitter user |
| `twitter_bookmarks` | Get bookmarked tweets |
| `twitter_likes` | Get liked tweets |

## Workflows

### Post a Tweet
1. Compose text — check it's under 280 characters
2. **Always confirm with user** before posting (especially public/controversial content)
3. `twitter_tweet` with text (and optional media path)
4. Confirm success
5. If auth error → recovery chain step 2

### Read Someone's Profile + Tweets
1. `twitter_about` with username — get bio, follower count, etc.
2. `twitter_user_tweets` with username — recent tweets
3. If API returns empty → `web_search("site:x.com @username")` as fallback

### Search for Topics
1. `twitter_search` with query (supports operators: `from:user`, `since:date`, `#hashtag`, `"exact phrase"`)
2. Present results with author, text, timestamp, engagement metrics
3. If empty results → `twitter_news` for trending topics, or `web_search` for broader results

### Check Mentions and Reply
1. `twitter_mentions` — get recent mentions
2. `twitter_read` for context on any specific mention
3. `twitter_thread` if the mention is part of a conversation
4. `twitter_reply` to respond

### Thread a Long Post
1. Break content into logical 280-char segments
2. Post first segment with `twitter_tweet`
3. Reply to each with `twitter_reply` using the previous tweet's URL/ID
4. Confirm the full thread

## CLI Fallback Reference

When MCP tools are down, use `execute()`:

| Command | Example |
|---------|---------|
| Check auth | `npx --yes @steipete/bird check` |
| Read tweet | `npx --yes @steipete/bird read "<url>" --json` |
| Search | `npx --yes @steipete/bird search "query" -n 10 --json` |
| Home feed | `npx --yes @steipete/bird home -n 20 --json` |
| Post tweet | `npx --yes @steipete/bird tweet "text" --json` |
| Reply | `npx --yes @steipete/bird reply "<url>" "text" --json` |
| User info | `npx --yes @steipete/bird about @username --json` |
| User tweets | `npx --yes @steipete/bird user-tweets @username -n 10 --json` |
| Trending | `npx --yes @steipete/bird news -n 10 --json` |
| Who am I | `npx --yes @steipete/bird whoami --json` |

## Character Limits and Formatting

- Standard tweets: **280 characters**
- Threads: each tweet is 280 chars; chain with `twitter_reply`
- URLs count toward the limit (Twitter shortens them but count still applies)
- Hashtags and @mentions count toward the limit
- Media: pass a file path to `twitter_tweet` with the `media` parameter

## Guidelines

- **Always confirm** tweet text with the user before posting public content
- Usernames work with or without `@` prefix — both are accepted
- For sensitive/controversial topics, draft and let the user review first
- Do NOT rapid-fire post — respect rate limits
- Use `twitter_news` for trending content instead of scraping
