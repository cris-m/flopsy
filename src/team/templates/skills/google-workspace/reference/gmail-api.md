# Gmail API Reference

Complete reference for Gmail MCP tools.

## gmail_list

List recent emails with optional filtering.

**Parameters:**
- `maxResults` (number, optional, default: 20) - Maximum number of emails to return
- `labelIds` (array of strings, optional) - Filter by label IDs (e.g., ["INBOX", "UNREAD"])
- `includeSpamTrash` (boolean, optional, default: false) - Include spam and trash

**Response:**
```json
{
  "success": true,
  "count": 5,
  "emails": [
    {
      "id": "message_id_123",
      "threadId": "thread_id_456",
      "subject": "Meeting Tomorrow",
      "from": "john@example.com",
      "to": "me@example.com",
      "date": "Mon, 27 Jan 2026 10:30:00 +0000",
      "snippet": "Quick preview of email content..."
    }
  ]
}
```

**Notes:**
- Returns emails sorted by most recent first
- Each email includes minimal metadata (no full body)
- Use `gmail_get` to retrieve full email content



## gmail_search

Search emails using Gmail query syntax.

**Parameters:**
- `query` (string, required) - Gmail search query
- `maxResults` (number, optional, default: 20) - Maximum results to return

**Query Syntax Examples:**
- `from:boss subject:urgent` - From specific sender with subject containing "urgent"
- `has:attachment after:2024/01/01` - Emails with attachments after Jan 1, 2024
- `is:unread in:inbox` - Unread emails in inbox
- `to:me cc:manager` - Emails to you and CC'd to manager
- `larger:10M` - Emails larger than 10MB
- `label:important` - Emails with "important" label

**Response:**
```json
{
  "success": true,
  "count": 3,
  "query": "from:boss subject:urgent",
  "emails": [
    {
      "id": "msg_789",
      "threadId": "thread_789",
      "subject": "Urgent: Review needed",
      "from": "boss@company.com",
      "to": "me@company.com",
      "date": "Mon, 27 Jan 2026 09:15:00 +0000",
      "body": "Full email body text...",
      "snippet": "Preview text..."
    }
  ]
}
```

**Notes:**
- Returns full email content (including body) for each result
- More expensive than `gmail_list` due to fetching full messages
- Use specific queries to reduce result count



## gmail_get

Get full content of a specific email by message ID.

**Parameters:**
- `messageId` (string, required) - Gmail message ID from list or search results

**Response:**
```json
{
  "success": true,
  "email": {
    "id": "msg_123",
    "threadId": "thread_456",
    "subject": "Project Update",
    "from": "colleague@company.com",
    "to": "me@company.com, team@company.com",
    "date": "Mon, 27 Jan 2026 14:22:00 +0000",
    "body": "Full email body content including all text...",
    "snippet": "Short preview..."
  }
}
```

**Notes:**
- Use this after `gmail_list` when you need full email content
- More efficient than `gmail_search` when you already have the message ID
- Body contains plain text or HTML (whichever is available)



## gmail_send

Send an email.

**Parameters:**
- `to` (string, required) - Recipient email address
- `subject` (string, required) - Email subject line
- `body` (string, required) - Email body in plain text
- `cc` (string, optional) - CC recipients (comma-separated)
- `bcc` (string, optional) - BCC recipients (comma-separated)

**Response:**
```json
{
  "success": true,
  "messageId": "sent_msg_123"
}
```

**Example:**
```javascript
gmail_send(
  to: "recipient@example.com",
  subject: "Meeting Follow-up",
  body: "Hi,\n\nThanks for the meeting today.\n\nBest,\nYour Name",
  cc: "manager@example.com"
)
```

**Limitations:**
- **Plain text only** - No HTML formatting supported
- **No attachments** - Cannot attach files directly (suggest Drive links instead)
- Content-Type is always `text/plain; charset="UTF-8"`

**Best Practices:**
- Use proper email etiquette (greeting, body, closing)
- Keep lines under 80 characters for readability
- Use `\n\n` for paragraph breaks
- For file sharing, use Drive links in the body



## gmail_draft

Create an email draft (not sent).

**Parameters:**
- `to` (string, required) - Recipient email address
- `subject` (string, required) - Email subject line
- `body` (string, required) - Email body in plain text

**Response:**
```json
{
  "success": true,
  "draftId": "draft_456"
}
```

**Notes:**
- Creates a draft in the user's Gmail drafts folder
- User can edit and send manually from Gmail UI
- Same limitations as `gmail_send` (plain text only, no attachments)
- Useful for review before sending



## gmail_mark_read

Mark an email as read.

**Parameters:**
- `messageId` (string, required) - Gmail message ID

**Response:**
```json
{
  "success": true,
  "messageId": "msg_123"
}
```

**Notes:**
- Removes the "UNREAD" label from the message
- No effect if message is already read
- Cannot undo (would need to manually re-mark as unread in Gmail)



## gmail_delete

Move email to trash.

**Parameters:**
- `messageId` (string, required) - Gmail message ID

**Response:**
```json
{
  "success": true,
  "messageId": "msg_123",
  "deleted": true
}
```

**Notes:**
- Moves to trash, not permanent deletion
- User can recover from trash within 30 days
- To permanently delete, user must empty trash manually
- Consider asking for confirmation before deleting



## gmail_labels

Get all Gmail labels (folders/categories).

**Parameters:**
None

**Response:**
```json
{
  "success": true,
  "labels": [
    {
      "id": "INBOX",
      "name": "INBOX",
      "type": "system"
    },
    {
      "id": "UNREAD",
      "name": "UNREAD",
      "type": "system"
    },
    {
      "id": "Label_123",
      "name": "Work Projects",
      "type": "user"
    }
  ]
}
```

**Label Types:**
- `system` - Built-in Gmail labels (INBOX, SENT, DRAFT, SPAM, TRASH, UNREAD, etc.)
- `user` - Custom labels created by user

**Common System Labels:**
- `INBOX` - Inbox
- `SENT` - Sent mail
- `DRAFT` - Drafts
- `SPAM` - Spam
- `TRASH` - Trash
- `UNREAD` - Unread messages
- `STARRED` - Starred messages
- `IMPORTANT` - Important messages

**Use Cases:**
- Get label IDs for use with `gmail_list`
- Show user their custom labels/folders
- Filter emails by category



## Error Handling

All tools return errors in this format:
```json
{
  "success": false,
  "error": "Error message here"
}
```

**Common Errors:**
- **Invalid email format** - Check email address syntax
- **Message not found** - Verify message ID exists
- **Authentication expired** - Token refresh handled automatically
- **Rate limit exceeded** - Wait a few minutes and retry
- **Permission denied** - Check OAuth scopes



## Authentication

Gmail tools use OAuth 2.0 with these scopes:
- `https://www.googleapis.com/auth/gmail.readonly` - Read emails
- `https://www.googleapis.com/auth/gmail.modify` - Modify emails (mark read, delete)
- `https://www.googleapis.com/auth/gmail.compose` - Create drafts
- `https://www.googleapis.com/auth/gmail.send` - Send emails

Token refresh happens automatically when expired.