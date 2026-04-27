---
name: apple-notes
compatibility: Designed for FlopsyBot agent
description: Create, read, update, and search notes in Apple Notes on macOS. Includes AppleScript fallback when the MCP server is unavailable.
---

# Apple Notes

Read and write notes in the macOS Apple Notes app via MCP tools. Falls back to AppleScript when MCP is unavailable.

## Recovery Chain

**CRITICAL: Follow this order on ANY failure. Do NOT stop at step 1.**

1. **MCP tool** (e.g., `notes_search`) — try the native tool first
2. **AppleScript fallback via `Bash`** — if MCP server is down or returns errors:
   ```
   Bash: osascript -e 'tell application "Notes" to get name of every note'
   Bash: osascript -e 'tell application "Notes" to get body of note "Title"'
   Bash: osascript -e 'tell application "Notes" to make new note at folder "Notes" with properties {name:"Title", body:"Content"}'
   ```
3. **Report failure** — ONLY after both MCP and AppleScript fail. State which steps were tried

**"Note not found"**: Don't give up after one search. Try:
- Different keywords (shorter, broader terms)
- `notes_list` to browse all notes first, then `notes_get` by ID
- AppleScript search via Bash: `osascript -e 'tell application "Notes" to get name of notes whose name contains "keyword"'`

## Platform Requirements

- macOS with the Notes app installed and accessible
- The apple-notes MCP server must be running and authorized
- If MCP is down, AppleScript fallback requires Notes app to be available (it auto-launches)

## Tools

| Tool | Purpose |
|------|---------|
| `notes_list` | List notes, optionally filtered by folder |
| `notes_search` | Search notes by title or content |
| `notes_get` | Read a specific note by ID |
| `notes_create` | Create a new note in a folder |
| `notes_update` | Update an existing note's content |
| `notes_delete` | Delete a note |
| `notes_folders` | List all folders in Notes |

## Workflows

### Creating a Note
1. Determine the target folder (ask user or use default)
2. Collect the note title and body content
3. `notes_create` with folder ID, title, and body
4. If MCP fails → run via Bash: `osascript -e 'tell application "Notes" to make new note at folder "Notes" with properties {name:"My Note", body:"Content here"}'`
5. Confirm creation

### Finding a Note
1. `notes_search` with relevant keywords
2. If no results → try shorter/broader keywords
3. If still no results → `notes_list` to browse all notes
4. If MCP fails → run via Bash: `osascript -e 'tell application "Notes" to get name of notes whose name contains "keyword"'`
5. `notes_get` to retrieve full content

### Updating a Note
1. Find the note (search or list)
2. `notes_get` to retrieve current content
3. Apply the requested changes
4. `notes_update` with the note ID and new content
5. If MCP fails → run via Bash: `osascript -e 'tell application "Notes" to set body of note "Title" to "New content"'`

## AppleScript Fallback Reference

When MCP tools are down, run these commands via `Bash`:

| Action | Command |
|--------|---------|
| List all notes | `osascript -e 'tell application "Notes" to get name of every note'` |
| List folders | `osascript -e 'tell application "Notes" to get name of every folder'` |
| Read a note | `osascript -e 'tell application "Notes" to get body of note "Title"'` |
| Search by title | `osascript -e 'tell application "Notes" to get name of notes whose name contains "keyword"'` |
| Create a note | `osascript -e 'tell application "Notes" to make new note at folder "Notes" with properties {name:"Title", body:"Content"}'` |
| Update a note | `osascript -e 'tell application "Notes" to set body of note "Title" to "New body"'` |
| Delete a note | `osascript -e 'tell application "Notes" to delete note "Title"'` |

**Note**: AppleScript works with note titles (not IDs). If multiple notes share a title, AppleScript operates on the first match.

## Guidelines

- Apple Notes content is plain text or basic rich text; heavy Markdown won't render in the Notes app
- Search is case-insensitive and matches both titles and body content
- Deleted notes may be recoverable from the trash, but not guaranteed via MCP
- When creating structured content, use simple formatting that Notes supports natively (bold, lists)
- AppleScript requires the Notes app to be available but it auto-launches if closed
