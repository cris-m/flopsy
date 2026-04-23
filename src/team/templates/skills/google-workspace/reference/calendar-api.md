# Google Calendar API Reference

Complete reference for Google Calendar MCP tools.

## calendar_list

Get meetings/events for a specific date.

**Parameters:**
- `date` (string, optional) - Date in YYYY-MM-DD format (defaults to today)
- `timezone` (string, optional, default: "UTC") - IANA timezone name

**Response:**
```json
{
  "success": true,
  "date": "2026-01-28",
  "timezone": "America/New_York",
  "count": 3,
  "meetings": [
    {
      "id": "event_123",
      "summary": "Team Standup",
      "description": "Daily sync meeting",
      "location": "Conference Room A",
      "start": "2026-01-28T09:00:00-05:00",
      "end": "2026-01-28T09:30:00-05:00",
      "attendees": ["team@company.com"],
      "htmlLink": "https://calendar.google.com/event?eid=...",
      "status": "confirmed"
    }
  ]
}
```

**Timezone Examples:**
- `America/New_York` - Eastern Time
- `America/Los_Angeles` - Pacific Time
- `Europe/London` - UK Time
- `Asia/Tokyo` - Japan Time
- `UTC` - Coordinated Universal Time

**Notes:**
- Returns events from 00:00:00 to 23:59:59 on specified date
- Events are sorted by start time
- Recurring events are expanded into individual instances
- All-day events included



## calendar_create

Schedule a new calendar event/meeting.

**Parameters:**
- `title` (string, required) - Event summary/subject
- `start` (string, required) - Start time in ISO 8601 format
- `end` (string, required) - End time in ISO 8601 format
- `attendees` (array of strings, optional) - Email addresses to invite
- `location` (string, optional) - Meeting location or video link
- `description` (string, optional) - Event details/agenda
- `timezone` (string, optional, default: "UTC") - IANA timezone
- `sendNotifications` (boolean, optional, default: true) - Send calendar invites

**ISO 8601 Format:**
- With timezone: `2026-01-28T15:00:00-05:00`
- UTC: `2026-01-28T20:00:00Z`
- Date only (all-day): `2026-01-28`

**Response:**
```json
{
  "success": true,
  "event": {
    "id": "event_456",
    "summary": "Project Review",
    "description": "Q1 project status review",
    "location": "https://meet.google.com/abc-defg-hij",
    "start": "2026-01-28T15:00:00-05:00",
    "end": "2026-01-28T16:00:00-05:00",
    "attendees": ["john@company.com", "sarah@company.com"],
    "htmlLink": "https://calendar.google.com/event?eid=...",
    "status": "confirmed"
  }
}
```

**Example:**
```javascript
calendar_create(
  title: "Weekly Sync",
  start: "2026-01-28T14:00:00",
  end: "2026-01-28T14:30:00",
  attendees: ["team@company.com"],
  location: "Conference Room B",
  description: "Weekly team synchronization",
  timezone: "America/New_York",
  sendNotifications: true
)
```

**Best Practices:**
- Always specify timezone explicitly
- For video meetings, include Google Meet link in location
- Set sendNotifications=true to email attendees
- Include agenda in description
- Default meeting length: 30-60 minutes



## calendar_update

Modify an existing calendar event.

**Parameters:**
- `eventId` (string, required) - Calendar event ID
- `title` (string, optional) - New event summary
- `start` (string, optional) - New start time (ISO 8601)
- `end` (string, optional) - New end time (ISO 8601)
- `attendees` (array of strings, optional) - Updated attendee list
- `location` (string, optional) - New location
- `description` (string, optional) - New description
- `timezone` (string, optional) - New timezone
- `sendNotifications` (boolean, optional, default: true) - Notify attendees of changes

**Response:**
```json
{
  "success": true,
  "event": {
    "id": "event_456",
    "summary": "Updated Meeting Title",
    "start": "2026-01-28T16:00:00-05:00",
    "end": "2026-01-28T17:00:00-05:00",
    ...
  }
}
```

**Notes:**
- Only provide parameters you want to change
- Omitted parameters remain unchanged
- Updating attendees replaces entire list (not additive)
- Setting sendNotifications=true sends update email to all attendees



## calendar_delete

Delete a calendar event.

**Parameters:**
- `eventId` (string, required) - Calendar event ID
- `sendNotifications` (boolean, optional, default: true) - Send cancellation notice

**Response:**
```json
{
  "success": true,
  "eventId": "event_456",
  "deleted": true
}
```

**Notes:**
- Event is permanently deleted from calendar
- If sendNotifications=true, attendees receive cancellation email
- Cannot undo deletion (would need to recreate event)
- Consider asking user for confirmation before deleting



## calendar_availability

Find available time slots on a specific date.

**Parameters:**
- `date` (string, optional) - Date in YYYY-MM-DD format (defaults to today)
- `workStart` (number, optional, default: 9) - Work day start hour (0-23)
- `workEnd` (number, optional, default: 17) - Work day end hour (0-23)
- `duration` (number, optional, default: 60) - Meeting duration in minutes
- `timezone` (string, optional, default: "UTC") - IANA timezone

**Response:**
```json
{
  "success": true,
  "date": "2026-01-28",
  "slots": [
    {
      "start": "2026-01-28T09:00:00Z",
      "end": "2026-01-28T10:30:00Z",
      "minutes": 90
    },
    {
      "start": "2026-01-28T14:00:00Z",
      "end": "2026-01-28T17:00:00Z",
      "minutes": 180
    }
  ]
}
```

**How It Works:**
1. Fetches all events for the specified date
2. Calculates gaps between events during work hours
3. Returns gaps that fit the requested meeting duration
4. Accounts for buffer time between meetings

**Example:**
```javascript
calendar_availability(
  date: "2026-01-29",
  workStart: 8,
  workEnd: 18,
  duration: 30,
  timezone: "America/Los_Angeles"
)
```

**Use Cases:**
- "When am I free tomorrow?"
- "Find a 30-minute slot this afternoon"
- "What times work for a 2-hour meeting on Friday?"



## calendar_invite

Add attendees to an existing meeting.

**Parameters:**
- `eventId` (string, required) - Calendar event ID
- `attendees` (array of strings, required) - Email addresses to invite
- `sendNotifications` (boolean, optional, default: true) - Send invites to new attendees

**Response:**
```json
{
  "success": true,
  "event": {
    "id": "event_789",
    "summary": "Team Meeting",
    "attendees": [
      "existing@company.com",
      "new1@company.com",
      "new2@company.com"
    ],
    ...
  }
}
```

**Notes:**
- Adds to existing attendee list (doesn't replace)
- Skips attendees already invited
- If sendNotifications=true, only new attendees receive invite
- Existing attendees not notified



## Error Handling

All tools return errors in this format:
```json
{
  "success": false,
  "error": "Error message here"
}
```

**Common Errors:**
- **Invalid date format** - Use YYYY-MM-DD or ISO 8601
- **Invalid timezone** - Use IANA timezone names (e.g., "America/New_York")
- **Event not found** - Verify eventId is correct
- **Missing required field** - Check title, start, end are provided
- **Event conflict** - Time slot already occupied (check with availability first)
- **Past event** - Cannot create events in the past



## Date/Time Handling

### ISO 8601 Format

**Date-time with timezone offset:**
```
2026-01-28T15:00:00-05:00
```

**Date-time in UTC:**
```
2026-01-28T20:00:00Z
```

**Date only (all-day event):**
```
2026-01-28
```

### Timezone Best Practices

1. **Always specify user's timezone** from AGENTS.md or conversation
2. **Convert to ISO 8601** with timezone offset
3. **Use IANA timezone names** (not abbreviations like "EST")
4. **Display times in user's local timezone**

### Example Conversion

```
User says: "Schedule a meeting tomorrow at 3pm"
User timezone: America/New_York (from AGENTS.md)
Today: 2026-01-27

1. Calculate date: tomorrow = 2026-01-28
2. Build start time: 2026-01-28T15:00:00
3. Add timezone: 2026-01-28T15:00:00-05:00
4. Build end time: 2026-01-28T16:00:00-05:00 (assume 1 hour)
```



## Recurring Events

The current tools do not support creating recurring events directly. Recurring events in list results are automatically expanded into individual instances.

To create recurring events, users would need to:
1. Create initial event via `calendar_create`
2. Manually edit in Google Calendar UI to add recurrence



## Authentication

Calendar tools use OAuth 2.0 with this scope:
- `https://www.googleapis.com/auth/calendar` - Full calendar access

Token refresh happens automatically when expired.