---
name: browser
compatibility: Designed for FlopsyBot agent
description: Automate web browsing tasks using Playwright. Use when the user needs to navigate websites, fill forms, extract page content, or interact with web applications.
---

# Browser

Automate web browsing and page interaction using Playwright via the browser MCP tools.

## Session Management — ALWAYS DO THIS FIRST

**Never launch a new browser without checking for existing sessions.**

```
Step 1: browser_list_sessions()
Step 2: If sessions exist → reuse. Use the existing sessionId.
Step 3: If no sessions → browser_connect (for user's Chrome) or browser_launch (for isolated).
```

**Why:** Launching new browsers is expensive and confusing. The user likely already has a session with their logins, cookies, and tabs. Reuse it.

| Scenario | Action |
|----------|--------|
| Active session exists | Use that sessionId for all subsequent calls |
| No session, user wants their Chrome | `browser_connect({ sessionId: "main", cdpUrl: "http://localhost:9222" })` |
| No session, isolated needed | `browser_launch({ sessionId: "main" })` |
| Need a new tab in existing session | `browser_new_page({ sessionId: "existing-id" })` — don't launch a new browser |

**Use a consistent sessionId** (e.g., `"main"`) across related tasks. Same sessionId = same browser, no duplicates.

**Use tabs, not new browsers.** To visit a new URL, open a tab with `browser_new_page` in the existing session — don't launch another browser. Use `browser_switch_page` to move between tabs, `browser_close_page` to close ones you're done with.

## When to Use This Skill

- User says "go to this website" or "fill out this form"
- User needs to extract specific information from a web page
- A task requires clicking through a multi-step web workflow
- Web content needs to be captured or converted (e.g., screenshot, page text)

## Core Tools

| Tool | Purpose |
|------|---------|
| `browser_list_sessions` | **Check first** — list active browser sessions |
| `browser_connect` | Connect to user's Chrome (has logins, extensions, cookies) |
| `browser_launch` | Launch isolated browser (clean state, no user data) |
| `browser_navigate` | Navigate to a URL |
| `browser_snapshot` | Get page accessibility tree (structured, fast) |
| `browser_screenshot` | Take a visual screenshot of the current page |
| `browser_get_text` | Extract all text content from the page |
| `browser_click` | Click an element by selector or description |
| `browser_type` | Type text into an input field |
| `browser_select` | Select an option in a dropdown |
| `browser_wait` | Wait for a page element to appear |
| `browser_scroll` | Scroll the page |
| `browser_evaluate` | Execute JavaScript in the page context |
| `browser_new_page` | Open a new tab in existing session |
| `browser_switch_page` | Switch between tabs |
| `browser_close_page` | Close a tab |
| `browser_close` | Close entire browser session |

## Workflow

### Before Any Browser Task
1. **`browser_list_sessions()`** — check for active sessions
2. If a session exists, use it. If not, launch/connect one.
3. Then proceed with the task.

### Simple Page Extraction
1. Check sessions → reuse or launch
2. Navigate to the URL with `browser_navigate`
3. Wait for the page to load with `browser_wait`
4. Extract text with `browser_get_text` or take a screenshot with `browser_screenshot`
5. Parse and present the relevant information

### Form Filling
1. Check sessions → reuse or launch
2. Navigate to the page containing the form
3. Take a screenshot to see the current state
4. Identify input fields (by label, placeholder, or selector)
5. Fill each field with `browser_type` or `browser_select`
6. Click the submit button with `browser_click`
7. Verify the result with a screenshot

### Multi-Step Workflow
1. Check sessions → reuse or launch
2. Start at the entry point URL
3. At each step: screenshot to understand the page, then act
4. Use `browser_wait` between navigation steps to ensure elements are loaded
5. Handle errors or unexpected states by taking a screenshot and reassessing

## Selectors

Elements can be targeted by:
- **CSS selector**: `#submit-btn`, `.form-input`, `input[name="email"]`
- **Text content**: the tool can match by visible text on the page
- **Aria label**: accessibility labels on interactive elements

## Guidelines

- **Reuse sessions** — always check `browser_list_sessions` before launching
- Always take a screenshot after navigating to verify the page loaded correctly
- Use `browser_wait` before interacting with elements that may load asynchronously
- Do not submit forms or make purchases without explicit user confirmation
- Some websites block automation; if a page returns a CAPTCHA or bot check, inform the user
- For sites requiring login, prefer `browser_connect` to use the user's Chrome with existing cookies
- Prefer `browser_get_text` for data extraction over screenshots when possible; it is faster and more structured
- **Close sessions when done** with long tasks to free resources
