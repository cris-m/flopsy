# Google Drive API Reference

Complete reference for Google Drive MCP tools.

## drive_list

List files in Google Drive.

**Parameters:**
- `maxResults` (number, optional, default: 50) - Maximum files to return
- `orderBy` (string, optional, default: "modifiedTime desc") - Sort order

**Sort Options:**
- `modifiedTime desc` - Most recently modified first
- `modifiedTime` - Oldest modified first
- `name` - Alphabetical by name
- `name desc` - Reverse alphabetical
- `createdTime desc` - Most recently created first

**Response:**
```json
{
  "success": true,
  "count": 15,
  "files": [
    {
      "id": "file_abc123",
      "name": "Project Proposal.docx",
      "mimeType": "application/vnd.google-apps.document",
      "size": "45632",
      "createdTime": "2026-01-15T10:30:00.000Z",
      "modifiedTime": "2026-01-27T14:22:00.000Z",
      "webViewLink": "https://docs.google.com/document/d/abc123/edit",
      "shared": false
    }
  ]
}
```

**Common MIME Types:**
- `application/vnd.google-apps.document` - Google Doc
- `application/vnd.google-apps.spreadsheet` - Google Sheet
- `application/vnd.google-apps.presentation` - Google Slides
- `application/vnd.google-apps.folder` - Folder
- `application/pdf` - PDF file
- `text/plain` - Text file
- `image/jpeg`, `image/png` - Images



## drive_search

Search for files by name or content.

**Parameters:**
- `query` (string, required) - Search term
- `maxResults` (number, optional, default: 50) - Maximum results

**Response:**
```json
{
  "success": true,
  "count": 8,
  "files": [
    {
      "id": "file_def456",
      "name": "Sales Report Q4.pdf",
      "mimeType": "application/pdf",
      "size": "2048576",
      "createdTime": "2026-01-20T09:00:00.000Z",
      "modifiedTime": "2026-01-25T16:45:00.000Z",
      "webViewLink": "https://drive.google.com/file/d/def456/view",
      "shared": true
    }
  ]
}
```

**How Search Works:**
The tool searches for files where the query appears in:
- File name (`name contains 'query'`)
- Full text content (`fullText contains 'query'`)

**Search Tips:**
- Use specific terms to narrow results
- File extensions work: "report.pdf"
- Partial matches work: "sales" finds "2024 Sales Report"
- Case-insensitive search

**Advanced Search:**
To use Google Drive's advanced query syntax, you would need to modify the search query construction in the tool code. Current implementation uses simple name/content matching.



## drive_get

Get file metadata by ID.

**Parameters:**
- `fileId` (string, required) - Google Drive file ID

**Response:**
```json
{
  "success": true,
  "file": {
    "id": "file_xyz789",
    "name": "Budget 2026.xlsx",
    "mimeType": "application/vnd.google-apps.spreadsheet",
    "size": "102400",
    "createdTime": "2026-01-10T08:00:00.000Z",
    "modifiedTime": "2026-01-26T11:30:00.000Z",
    "webViewLink": "https://docs.google.com/spreadsheets/d/xyz789/edit",
    "shared": false
  }
}
```

**Use Cases:**
- Verify file exists before operations
- Get current metadata after modifications
- Check sharing status
- Get web link for sharing



## drive_read

Read file contents (text files only).

**Parameters:**
- `fileId` (string, required) - Google Drive file ID

**Response:**
```json
{
  "success": true,
  "content": "File contents here as plain text..."
}
```

**Supported File Types:**
- Plain text files (.txt)
- Google Docs (converted to plain text)
- Markdown files (.md)
- CSV files
- Other text-based formats

**NOT Supported:**
- Binary files (images, videos, executables)
- PDFs (cannot extract text with this tool)
- Spreadsheets with formulas/formatting
- Presentations

**Notes:**
- Google Docs are exported as plain text (formatting lost)
- Large files may be truncated
- For binary files, provide webViewLink instead



## drive_create_folder

Create a new folder.

**Parameters:**
- `name` (string, required) - Folder name
- `parentId` (string, optional) - Parent folder ID (defaults to root)

**Response:**
```json
{
  "success": true,
  "folder": {
    "id": "folder_123abc",
    "name": "Project Files",
    "mimeType": "application/vnd.google-apps.folder",
    "webViewLink": "https://drive.google.com/drive/folders/123abc"
  }
}
```

**Example:**
```javascript
// Create folder in root
drive_create_folder(name: "2026 Reports")

// Create subfolder
drive_create_folder(
  name: "Q1 Reports",
  parentId: "folder_123abc"
)
```



## drive_share

Share a file with specific permissions.

**Parameters:**
- `fileId` (string, required) - File ID to share
- `email` (string, optional) - Email address to share with (omit for public sharing)
- `role` (string, optional, default: "reader") - Permission level
- `type` (string, optional, default: "user") - Permission type
- `notify` (boolean, optional, default: false) - Send notification email

**Role Options:**
- `reader` - Can view only
- `writer` - Can edit
- `commenter` - Can comment (Docs/Sheets/Slides)
- `owner` - Full ownership (transfer ownership)

**Type Options:**
- `user` - Specific user by email
- `anyone` - Anyone with the link (public)
- `domain` - Anyone in your organization

**Response:**
```json
{
  "success": true,
  "permissionId": "perm_456def",
  "link": "https://docs.google.com/document/d/abc123/edit",
  "shared": "Shared with john@example.com"
}
```

**Examples:**
```javascript
// Share with specific person (edit access)
drive_share(
  fileId: "file_abc",
  email: "colleague@company.com",
  role: "writer",
  notify: true
)

// Make public (view only)
drive_share(
  fileId: "file_abc",
  type: "anyone",
  role: "reader"
)

// Share with domain (organization only)
drive_share(
  fileId: "file_abc",
  type: "domain",
  role: "reader"
)
```



## drive_permissions

Get sharing permissions for a file.

**Parameters:**
- `fileId` (string, required) - File ID

**Response:**
```json
{
  "success": true,
  "permissions": [
    {
      "id": "perm_123",
      "type": "user",
      "role": "owner",
      "email": "me@company.com"
    },
    {
      "id": "perm_456",
      "type": "user",
      "role": "writer",
      "email": "editor@company.com"
    },
    {
      "id": "perm_789",
      "type": "anyone",
      "role": "reader",
      "email": null
    }
  ]
}
```

**Use Cases:**
- Check who has access before sharing
- Audit file permissions
- Verify public sharing status
- See collaboration permissions



## drive_copy

Make a copy of a file.

**Parameters:**
- `fileId` (string, required) - File ID to copy
- `newName` (string, optional) - Name for the copy
- `parentId` (string, optional) - Destination folder

**Response:**
```json
{
  "success": true,
  "file": {
    "id": "file_copy_123",
    "name": "Budget 2026 (Copy)",
    "mimeType": "application/vnd.google-apps.spreadsheet",
    "webViewLink": "https://docs.google.com/spreadsheets/d/copy_123/edit"
  }
}
```

**Example:**
```javascript
drive_copy(
  fileId: "file_original",
  newName: "Budget 2026 - Draft v2",
  parentId: "folder_drafts"
)
```

**Notes:**
- If newName omitted, adds " (Copy)" to original name
- Copies file content and structure
- Does NOT copy permissions (copy is private to you)
- Cannot copy folders directly



## drive_move

Move a file to a different folder.

**Parameters:**
- `fileId` (string, required) - File ID to move
- `folderId` (string, required) - Destination folder ID

**Response:**
```json
{
  "success": true,
  "fileId": "file_abc",
  "movedTo": "folder_xyz"
}
```

**Notes:**
- Removes file from current parent folder(s)
- Adds to new parent folder
- File ID remains the same
- Sharing links remain valid
- Permissions remain unchanged



## drive_rename

Rename a file or folder.

**Parameters:**
- `fileId` (string, required) - File/folder ID
- `newName` (string, required) - New name

**Response:**
```json
{
  "success": true,
  "file": {
    "id": "file_abc",
    "name": "Updated Project Plan"
  }
}
```

**Notes:**
- Changes display name only
- File ID remains the same
- Sharing links remain valid
- No need to include file extension (it's preserved)



## drive_storage

Get Google Drive storage usage.

**Parameters:**
None

**Response:**
```json
{
  "success": true,
  "usageBytes": 5368709120,
  "limitBytes": 16106127360,
  "usageFormatted": "5.00 GB",
  "limitFormatted": "15.00 GB",
  "usagePercent": "33.33%"
}
```

**Storage Quota:**
- Free accounts: 15 GB (shared with Gmail and Photos)
- Google One subscribers: 100 GB, 200 GB, 2 TB, etc.
- Workspace accounts: Varies by plan

**Use Cases:**
- Check before uploading large files
- Notify user when storage is low
- Suggest cleanup if quota exceeded



## Error Handling

All tools return errors in this format:
```json
{
  "success": false,
  "error": "Error message here"
}
```

**Common Errors:**
- **File not found** - Invalid fileId or file deleted
- **Permission denied** - User lacks access to file
- **Quota exceeded** - Storage limit reached
- **Invalid parent** - Folder ID doesn't exist
- **Rate limit exceeded** - Too many API requests



## File IDs

**Getting File IDs:**
- From `drive_list` or `drive_search` results
- From webViewLink: `https://docs.google.com/document/d/FILE_ID/edit`
- From share links

**File ID Format:**
- Alphanumeric string
- Example: `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms`



## Best Practices

**Search Strategy:**
1. Start with specific terms
2. If too many results, add more details
3. Check modified dates to find recent files
4. Use webViewLink to let users verify correct file

**Sharing Strategy:**
1. Default to `reader` role unless edit access needed
2. Set `notify=true` when sharing with specific people
3. Check existing permissions before sharing
4. Provide shareable link after granting access

**Organization:**
1. Create folders for projects
2. Use descriptive file names
3. Move files to appropriate folders
4. Regular cleanup of old files



## Authentication

Drive tools use OAuth 2.0 with this scope:
- `https://www.googleapis.com/auth/drive` - Full Drive access

Token refresh happens automatically when expired.