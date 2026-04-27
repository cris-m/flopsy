---
name: apple-reminders
compatibility: Designed for FlopsyBot agent
description: Create, read, update, and delete reminders in Apple Reminders on macOS. Includes AppleScript fallback when the MCP server is unavailable.
---

# Apple Reminders

Manage tasks and reminders through the macOS Apple Reminders integration via MCP tools. Falls back to AppleScript when MCP is unavailable.

## Recovery Chain

**CRITICAL: Follow this order on ANY failure. Do NOT stop at step 1.**

1. **MCP tool** (e.g., `reminders_create`) — try the native tool first
2. **AppleScript fallback via `Bash`** — if MCP server is down or returns errors:
   ```
   Bash: osascript -e 'tell application "Reminders" to get name of every list'
   Bash: osascript -e 'tell application "Reminders" to make new reminder in list "Reminders" with properties {name:"Buy milk", due date:date "2026-02-15 09:00:00"}'
   ```
3. **Report failure** — ONLY after both MCP and AppleScript fail. State which steps were tried

## Platform Requirements

- macOS with the Reminders app installed and accessible
- The apple-reminders MCP server must be running and authorized
- If MCP is down, AppleScript requires Reminders app to be available (it auto-launches)

## Tools

| Tool | Purpose |
|------|---------|
| `reminders_list` | List all reminder lists (folders) |
| `reminders_get` | Get reminders in a specific list |
| `reminders_create` | Create a new reminder (with optional due date, list) |
| `reminders_complete` | Mark a reminder as completed |
| `reminders_delete` | Delete a reminder |

## Workflows

### Creating a Reminder
1. Ask which list to add to (or use default list)
2. Collect the reminder title and optional due date/time
3. `reminders_create` with list ID, title, and due date
4. If MCP fails → run via Bash: `osascript -e 'tell application "Reminders" to make new reminder in list "Reminders" with properties {name:"Task", due date:date "2026-02-15 09:00:00"}'`
5. Confirm creation

### Checking Reminders
1. `reminders_list` to list available reminder lists
2. `reminders_get` from the relevant list
3. If MCP fails → run via Bash: `osascript -e 'tell application "Reminders" to get name of every reminder in list "Reminders" whose completed is false'`
4. Present pending items clearly

### Completing or Deleting
1. Identify the reminder by title or ID
2. `reminders_complete` or `reminders_delete` as appropriate
3. If MCP fails → run via Bash: `osascript -e 'tell application "Reminders" to set completed of reminder "Task" in list "Reminders" to true'`
4. Confirm the action

## AppleScript Fallback Reference

When MCP tools are down, run these commands via `Bash`:

| Action | Command |
|--------|---------|
| List all lists | `osascript -e 'tell application "Reminders" to get name of every list'` |
| Get reminders | `osascript -e 'tell application "Reminders" to get name of every reminder in list "Reminders" whose completed is false'` |
| Create reminder | `osascript -e 'tell application "Reminders" to make new reminder in list "Reminders" with properties {name:"Task", due date:date "2026-02-15 09:00:00"}'` |
| Create (no date) | `osascript -e 'tell application "Reminders" to make new reminder in list "Reminders" with properties {name:"Task"}'` |
| Complete | `osascript -e 'tell application "Reminders" to set completed of reminder "Task" in list "Reminders" to true'` |
| Delete | `osascript -e 'tell application "Reminders" to delete reminder "Task" in list "Reminders"'` |

**Note**: AppleScript date format is `"YYYY-MM-DD HH:MM:SS"`. The Reminders app auto-launches if closed.

## Guidelines

- Always confirm the list before creating if the user has multiple reminder lists
- Due dates should be in the user's local timezone; convert if needed
- Completed reminders can still be retrieved with the appropriate filter
- Location-based triggers are device-side only; note this limitation if asked
- AppleScript operates by name (not ID); be precise with reminder/list names
