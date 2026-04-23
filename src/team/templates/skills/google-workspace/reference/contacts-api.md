# Google Contacts API Reference

Complete documentation for Google Contacts (People API) tools.

## Tools Overview

| Tool | Description |
|------|-------------|
| `contacts_list` | List contacts with optional filtering |
| `contacts_search` | Search contacts by name, email, or phone |
| `contacts_get` | Get full details of a contact |
| `contacts_create` | Create a new contact |
| `contacts_update` | Update an existing contact |
| `contacts_delete` | Delete a contact |
| `contacts_groups` | List contact groups/labels |



## contacts_list

List contacts from the user's Google Contacts.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pageSize` | number | No | Maximum contacts to return (default: 100, max: 1000) |
| `pageToken` | string | No | Token for pagination |
| `sortOrder` | string | No | "LAST_MODIFIED_ASCENDING" or "LAST_MODIFIED_DESCENDING" or "FIRST_NAME_ASCENDING" or "LAST_NAME_ASCENDING" |

### Response

```json
{
  "connections": [
    {
      "resourceName": "people/c12345678901234567890",
      "etag": "%EgUBAj...",
      "names": [
        {
          "displayName": "John Smith",
          "givenName": "John",
          "familyName": "Smith"
        }
      ],
      "emailAddresses": [
        {
          "value": "john.smith@example.com",
          "type": "work"
        }
      ],
      "phoneNumbers": [
        {
          "value": "+1-555-123-4567",
          "type": "mobile"
        }
      ]
    }
  ],
  "nextPageToken": "...",
  "totalItems": 150
}
```



## contacts_search

Search contacts by name, email, phone, or other fields.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (name, email, phone) |
| `pageSize` | number | No | Maximum results (default: 30) |

### Search Behavior

- Searches across names, emails, phone numbers, and organizations
- Case-insensitive matching
- Partial matching supported (e.g., "john" matches "Johnson")

### Response

```json
{
  "results": [
    {
      "person": {
        "resourceName": "people/c12345678901234567890",
        "names": [{ "displayName": "John Smith" }],
        "emailAddresses": [{ "value": "john@example.com" }],
        "phoneNumbers": [{ "value": "+1-555-123-4567" }],
        "organizations": [{ "name": "Acme Corp", "title": "Engineer" }]
      }
    }
  ]
}
```



## contacts_get

Get full details of a specific contact.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `resourceName` | string | Yes | Contact resource name (e.g., "people/c123...") |

### Response

```json
{
  "resourceName": "people/c12345678901234567890",
  "etag": "%EgUBAj...",
  "names": [
    {
      "displayName": "John Smith",
      "givenName": "John",
      "familyName": "Smith",
      "displayNameLastFirst": "Smith, John"
    }
  ],
  "emailAddresses": [
    { "value": "john.smith@work.com", "type": "work" },
    { "value": "john@personal.com", "type": "home" }
  ],
  "phoneNumbers": [
    { "value": "+1-555-123-4567", "type": "mobile" },
    { "value": "+1-555-987-6543", "type": "work" }
  ],
  "addresses": [
    {
      "type": "work",
      "formattedValue": "123 Main St, San Francisco, CA 94105",
      "streetAddress": "123 Main St",
      "city": "San Francisco",
      "region": "CA",
      "postalCode": "94105",
      "country": "USA"
    }
  ],
  "organizations": [
    {
      "name": "Acme Corporation",
      "title": "Senior Engineer",
      "department": "Engineering"
    }
  ],
  "birthdays": [
    { "date": { "year": 1985, "month": 6, "day": 15 } }
  ],
  "urls": [
    { "value": "https://linkedin.com/in/johnsmith", "type": "profile" }
  ],
  "biographies": [
    { "value": "Met at Tech Conference 2024" }
  ],
  "memberships": [
    { "contactGroupMembership": { "contactGroupResourceName": "contactGroups/friends" } }
  ]
}
```



## contacts_create

Create a new contact.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `givenName` | string | Yes | First name |
| `familyName` | string | No | Last name |
| `email` | string | No | Email address |
| `emailType` | string | No | "work", "home", or "other" (default: "work") |
| `phone` | string | No | Phone number |
| `phoneType` | string | No | "mobile", "work", "home" (default: "mobile") |
| `organization` | string | No | Company name |
| `title` | string | No | Job title |
| `notes` | string | No | Notes/biography |
| `address` | object | No | Address object (see below) |

### Address Object

```json
{
  "streetAddress": "123 Main St",
  "city": "San Francisco",
  "region": "CA",
  "postalCode": "94105",
  "country": "USA",
  "type": "work"
}
```

### Response

Returns the created contact with assigned `resourceName`.



## contacts_update

Update an existing contact.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `resourceName` | string | Yes | Contact resource name |
| `givenName` | string | No | New first name |
| `familyName` | string | No | New last name |
| `email` | string | No | New/additional email |
| `phone` | string | No | New/additional phone |
| `organization` | string | No | New company |
| `title` | string | No | New job title |
| `notes` | string | No | New notes |

### Important

- Use `contacts_get` first to retrieve current `etag`
- Include `etag` in update to prevent conflicts
- Only specified fields are updated; others remain unchanged

### Response

Returns the updated contact object.



## contacts_delete

Delete a contact.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `resourceName` | string | Yes | Contact resource name |

### Response

Empty response on success (HTTP 200).

**Note:** Deleted contacts may be recoverable from Google Contacts trash for 30 days.



## contacts_groups

List contact groups (labels).

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pageSize` | number | No | Maximum groups to return (default: 100) |

### Response

```json
{
  "contactGroups": [
    {
      "resourceName": "contactGroups/friends",
      "name": "Friends",
      "memberCount": 25,
      "groupType": "USER_CONTACT_GROUP"
    },
    {
      "resourceName": "contactGroups/family",
      "name": "Family",
      "memberCount": 12,
      "groupType": "USER_CONTACT_GROUP"
    },
    {
      "resourceName": "contactGroups/myContacts",
      "name": "My Contacts",
      "memberCount": 150,
      "groupType": "SYSTEM_CONTACT_GROUP"
    }
  ]
}
```

### Group Types

- `USER_CONTACT_GROUP` - User-created labels
- `SYSTEM_CONTACT_GROUP` - System groups (My Contacts, Starred, etc.)



## Common Patterns

### Find Contact by Email

```
contacts_search(query="john@example.com")
```

### Find Contact by Phone

```
contacts_search(query="+1-555-123-4567")
```

### Create Work Contact

```
contacts_create(
  givenName="Sarah",
  familyName="Johnson",
  email="sarah.johnson@company.com",
  emailType="work",
  phone="+1-555-987-6543",
  phoneType="work",
  organization="TechCorp",
  title="Product Manager"
)
```

### Add Note to Contact

```
// First get the contact
contact = contacts_get(resourceName="people/c123...")

// Then update with note
contacts_update(
  resourceName="people/c123...",
  notes="Met at conference. Interested in partnership."
)
```



## Field Types Reference

### Email Types
- `work` - Work email
- `home` - Personal email
- `other` - Other email

### Phone Types
- `mobile` - Mobile phone
- `work` - Work phone
- `home` - Home phone
- `main` - Main number
- `workFax` - Work fax
- `homeFax` - Home fax
- `pager` - Pager
- `other` - Other

### Address Types
- `work` - Work address
- `home` - Home address
- `other` - Other address



## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `404 Not Found` | Invalid resourceName | Verify from search/list results |
| `400 Bad Request` | Missing required field | Ensure givenName is provided |
| `409 Conflict` | Etag mismatch | Refetch contact and retry |
| `403 Forbidden` | No access | Check API permissions |
| `429 Too Many Requests` | Rate limited | Wait and retry |



## Integration Tips

### With Gmail
- Look up sender's contact info before replying
- Create contacts from important email senders
- Use contact's preferred name in email greetings

### With Calendar
- Look up attendee contact details
- Verify email addresses before sending invites
- Add meeting contacts to appropriate groups

### With Tasks
- Reference contact in task notes
- Create follow-up tasks with contact info

### Best Practices
- Always search before creating (avoid duplicates)
- Use consistent naming conventions
- Keep contact groups organized
- Add notes with context (how you met, etc.)
