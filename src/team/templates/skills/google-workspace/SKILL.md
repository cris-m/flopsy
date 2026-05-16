---
name: google-workspace
compatibility: Designed for FlopsyBot agent
description: Interact with Gmail, Google Calendar, Drive, Tasks, and Contacts via MCP tools. Use when the user wants to send email, check calendar, manage files, create tasks, or look up contacts.
---

# Google Workspace

Manage Gmail, Google Calendar, Google Drive, Google Tasks, and Google Contacts through dedicated MCP tools. Detailed API references live in the `reference/` directory alongside this file.

## When to Use This Skill

- User wants to send, read, search, or manage emails (Gmail)
- User wants to check schedule, create events, or find free time (Calendar)
- User wants to find, share, or organize files (Drive)
- User wants to create or manage to-do items (Tasks)
- User wants to look up or manage contacts (Contacts)

## Authentication

All Google Workspace tools use OAuth 2.0. Tokens are stored at `.flopsy/sessions/google/token.json` (path derived from the MCP server name via `resolveFromRoot()`). Token refresh is automatic when the token expires. If all tools return permission errors, the user needs to re-authorize via the browser-based OAuth flow.

## Tool Groups at a Glance

### Gmail
| Tool | Purpose |
|------|---------|
| `gmail_list` | List recent emails, optionally filter by label |
| `gmail_search` | Search emails with Gmail query syntax |
| `gmail_get` | Read full email by message ID |
| `gmail_send` | Send an email (plain text only, no attachments) |
| `gmail_draft` | Save an email as a draft for user review |
| `gmail_mark_read` | Mark an email as read |
| `gmail_delete` | Move an email to trash |
| `gmail_labels` | List all Gmail labels/folders |

### Calendar
| Tool | Purpose |
|------|---------|
| `calendar_list` | List events for a given date |
| `calendar_create` | Create a new event |
| `calendar_update` | Modify an existing event |
| `calendar_delete` | Delete an event |
| `calendar_availability` | Find open time slots on a date |
| `calendar_invite` | Add attendees to an existing event |

### Drive
| Tool | Purpose |
|------|---------|
| `drive_list` | List files in Drive |
| `drive_search` | Search files by name or content |
| `drive_get` | Get file metadata |
| `drive_read` | Read text file contents |
| `drive_create_folder` | Create a new folder |
| `drive_share` | Share a file with permissions |
| `drive_permissions` | View sharing permissions |
| `drive_copy` | Copy a file |
| `drive_move` | Move a file to a folder |
| `drive_rename` | Rename a file or folder |
| `drive_storage` | Check storage quota |

> **Note**: Google Tasks and Google Contacts MCP servers are not currently wired into FlopsyBot. The `tasks_*` and `contacts_*` tool families do not exist. For tasks use Todoist (`todoist` MCP) or Apple Reminders (`apple-reminders` MCP). For contacts, ask the user for the recipient's email or look them up in their last email thread via `gmail_search`.

## Common Workflows

### Send an Email
1. If only the recipient's name is known, search a recent thread via `gmail_search` to find their address
2. Compose the message (plain text; no HTML or attachments supported)
3. If the user wants to review first, use `gmail_draft`; otherwise use `gmail_send`

### Schedule a Meeting
1. Check availability with `calendar_availability` for the desired date
2. Look up attendee emails with `contacts_search`
3. Create the event with `calendar_create`, specifying timezone explicitly
4. Confirm details with the user

### Find and Share a File
1. Search with `drive_search` using the file name or topic
2. Verify the correct file with `drive_get`
3. Share with `drive_share`, defaulting to reader role unless edit access is requested

## Guidelines

- Always specify timezone explicitly when creating calendar events; use IANA names (e.g., `America/New_York`)
- Gmail send is plain text only; suggest Drive links for file sharing in emails
- Search before creating contacts to avoid duplicates
- For detailed parameter references, consult the files in `reference/` (gmail-api.md, calendar-api.md, drive-api.md, tasks-api.md, contacts-api.md)
