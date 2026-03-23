---
name: notion
compatibility: Designed for FlopsyBot agent
description: Read, create, and update pages and databases in Notion. Includes token validation, API fallback via http_request, and database ID resolution.
---

# Notion

Interact with the user's Notion workspace to read, create, and update pages and databases via MCP tools. Falls back to direct API calls when MCP is unavailable.

## Recovery Chain

**CRITICAL: Follow this order on ANY failure. Do NOT stop at step 1.**

1. **MCP tool** (e.g., `notion_pages_search`) — try the native tool first
2. **Token check** — if auth error, verify the token is set (NEVER print the value):
   ```
   execute("[ -n \"$NOTION_API_KEY\" ] && echo 'set' || echo 'NOT SET'")
   execute("[ -f ~/.config/notion/api_key ] && echo 'file exists' || echo 'NOT FOUND'")
   ```
3. **Direct API fallback via `http_request`** — if MCP server is down but token exists:
   ```
   http_request({
     url: "https://api.notion.com/v1/search",
     method: "POST",
     headers: {"Authorization": "Bearer <token>", "Notion-Version": "2022-06-28"},
     body: {"query": "search term"}
   })
   ```
4. **Report failure** — ONLY after steps 1-3 fail. State which steps were tried

**"Page not found" / empty results**: The Notion integration can only see pages/databases explicitly shared with it. Tell the user: "This page may not be shared with the Notion integration. In Notion, open the page → Share → invite the integration."

**Database ID confusion**: Notion has Page IDs, Database IDs, and Block IDs — they look identical (32-char hex). When a "database not found" error occurs:
1. `notion_pages_search` with the database name to find the correct ID
2. `notion_databases_list` to browse all accessible databases
3. Try the ID as a page with `notion_pages_get` — it may be a page, not a database

## Authentication

Notion uses an integration token (secret key starting with `ntn_` or `secret_`) configured in the MCP server's environment. The token grants access only to pages and databases shared with the integration in the Notion UI.

**Token validation**: If tools return 401/unauthorized:
1. Check if `NOTION_API_KEY` env var is set
2. Verify the token hasn't been revoked in Notion's integration settings
3. Confirm the target page/database is shared with the integration

## Tools

| Tool | Purpose |
|------|---------|
| `notion_pages_list` | List pages accessible to the integration |
| `notion_pages_search` | Search pages and databases by title or content |
| `notion_pages_get` | Read a specific page |
| `notion_pages_create` | Create a new page under a parent |
| `notion_pages_update` | Update page content or properties |
| `notion_databases_list` | List databases |
| `notion_databases_get` | Get database schema and entries |
| `notion_databases_query` | Query a database with filters and sorts |
| `notion_databases_create_entry` | Add a row to a database |
| `notion_databases_update_entry` | Update a database row |

## Workflows

### Creating a Page
1. Find the parent page/database: `notion_pages_search` or `notion_databases_list`
2. Collect title and content
3. `notion_pages_create` with parent ID, title, and body (rich text blocks)
4. If MCP fails → use `http_request` to POST to `https://api.notion.com/v1/pages`
5. Return the page URL to the user

### Querying a Database
1. Find the database: `notion_databases_list` or `notion_pages_search`
2. Get schema: `notion_databases_get` — understand property names and types
3. Query: `notion_databases_query` with filters matching the schema types
4. If query returns "database not found" → check if the ID is actually a page, not a database
5. Present results in a clear table or list format

### Updating Content
1. Find the target: search or list
2. Read current content to understand structure
3. `notion_pages_update` or `notion_databases_update_entry`
4. If MCP fails → use `http_request` to PATCH the appropriate endpoint

## API Fallback Reference

When MCP tools are down, use `http_request` with these endpoints:

| Action | Method | URL |
|--------|--------|-----|
| Search | POST | `https://api.notion.com/v1/search` |
| Get page | GET | `https://api.notion.com/v1/pages/{page_id}` |
| Create page | POST | `https://api.notion.com/v1/pages` |
| Update page | PATCH | `https://api.notion.com/v1/pages/{page_id}` |
| Query database | POST | `https://api.notion.com/v1/databases/{db_id}/query` |
| Get database | GET | `https://api.notion.com/v1/databases/{db_id}` |

**Required headers** for all requests:
```
Authorization: Bearer <NOTION_API_KEY>
Notion-Version: 2022-06-28
Content-Type: application/json
```

## Guidelines

- Notion's block-based model means page bodies are arrays of blocks (paragraphs, headings, bullets, code, etc.)
- Database property types (title, rich_text, number, select, date, checkbox) must match the schema — get schema before creating entries
- Pages not shared with the integration are invisible; inform the user if a page can't be found
- API rate limits are generous but not unlimited; avoid tight loops over large page sets
- IDs are 32-character hex strings — page IDs, database IDs, and block IDs all look the same
