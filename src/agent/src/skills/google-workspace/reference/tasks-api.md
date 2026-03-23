# Google Tasks API Reference

Complete documentation for Google Tasks tools.

## Tools Overview

| Tool | Description |
|------|-------------|
| `tasks_lists` | Get all task lists |
| `tasks_list` | List tasks in a task list |
| `tasks_get` | Get a specific task |
| `tasks_create` | Create a new task |
| `tasks_update` | Update an existing task |
| `tasks_complete` | Mark task as completed |
| `tasks_delete` | Delete a task |
| `tasks_move` | Reorder or nest a task |



## tasks_lists

Get all task lists for the authenticated user.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `maxResults` | number | No | Maximum lists to return (default: 100) |

### Response

```json
{
  "items": [
    {
      "id": "MTIzNDU2Nzg5",
      "title": "My Tasks",
      "updated": "2026-01-28T10:30:00.000Z"
    },
    {
      "id": "QWJjRGVmR2hp",
      "title": "Work Tasks",
      "updated": "2026-01-27T15:45:00.000Z"
    }
  ]
}
```



## tasks_list

List tasks in a specific task list.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskListId` | string | No | Task list ID (default: "@default" for primary) |
| `maxResults` | number | No | Maximum tasks to return (default: 100) |
| `showCompleted` | boolean | No | Include completed tasks (default: true) |
| `showHidden` | boolean | No | Include hidden tasks (default: false) |
| `dueMin` | string | No | Lower bound for due date (RFC 3339) |
| `dueMax` | string | No | Upper bound for due date (RFC 3339) |

### Response

```json
{
  "items": [
    {
      "id": "task123",
      "title": "Call John about project",
      "notes": "Discuss timeline",
      "due": "2026-01-31T00:00:00.000Z",
      "status": "needsAction",
      "position": "00000000000000000001",
      "updated": "2026-01-28T10:00:00.000Z"
    }
  ]
}
```

### Task Status Values

- `needsAction` - Task is not completed
- `completed` - Task is completed



## tasks_get

Get details of a specific task.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskListId` | string | No | Task list ID (default: "@default") |
| `taskId` | string | Yes | The task ID |

### Response

```json
{
  "id": "task123",
  "title": "Call John about project",
  "notes": "Discuss timeline and deliverables",
  "due": "2026-01-31T00:00:00.000Z",
  "status": "needsAction",
  "parent": null,
  "position": "00000000000000000001",
  "updated": "2026-01-28T10:00:00.000Z",
  "completed": null,
  "links": []
}
```



## tasks_create

Create a new task.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskListId` | string | No | Task list ID (default: "@default") |
| `title` | string | Yes | Task title/description |
| `notes` | string | No | Additional details |
| `due` | string | No | Due date in RFC 3339 format |
| `parent` | string | No | Parent task ID (for subtasks) |
| `previous` | string | No | Previous sibling task ID (for ordering) |

### Due Date Format

RFC 3339 format: `YYYY-MM-DDTHH:MM:SSZ`

Examples:
- `2026-01-31T00:00:00Z` - January 31, 2026 (all day)
- `2026-01-31T17:00:00Z` - January 31, 2026 at 5:00 PM UTC

### Response

Returns the created task object with assigned `id`.



## tasks_update

Update an existing task.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskListId` | string | No | Task list ID (default: "@default") |
| `taskId` | string | Yes | The task ID to update |
| `title` | string | No | New title |
| `notes` | string | No | New notes |
| `due` | string | No | New due date (RFC 3339) |
| `status` | string | No | "needsAction" or "completed" |

### Response

Returns the updated task object.



## tasks_complete

Mark a task as completed.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskListId` | string | No | Task list ID (default: "@default") |
| `taskId` | string | Yes | The task ID to complete |

### Response

Returns the updated task with `status: "completed"` and `completed` timestamp.



## tasks_delete

Delete a task.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskListId` | string | No | Task list ID (default: "@default") |
| `taskId` | string | Yes | The task ID to delete |

### Response

Empty response on success (HTTP 204).



## tasks_move

Move a task to a different position or make it a subtask.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskListId` | string | No | Task list ID (default: "@default") |
| `taskId` | string | Yes | The task ID to move |
| `parent` | string | No | New parent task ID (makes it a subtask) |
| `previous` | string | No | Task ID to position after |

### Response

Returns the moved task with updated `position` and `parent`.



## Common Patterns

### Create Task with Due Date

```
tasks_create(
  title="Review quarterly report",
  notes="Check financials and projections",
  due="2026-02-01T17:00:00Z"
)
```

### List Overdue Tasks

```
tasks_list(
  dueMax="2026-01-28T00:00:00Z",
  showCompleted=false
)
```

### Create Subtask

```
// First create parent task
parent = tasks_create(title="Project Alpha")

// Then create subtask
tasks_create(
  title="Research phase",
  parent=parent.id
)
```

### Move Task to Top of List

```
tasks_move(
  taskId="task123",
  previous=null  // null means move to top
)
```



## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `404 Not Found` | Invalid task or list ID | Verify IDs from list results |
| `400 Bad Request` | Invalid date format | Use RFC 3339 format |
| `403 Forbidden` | No access to task list | Check permissions |
| `409 Conflict` | Concurrent modification | Retry the operation |



## Integration Tips

### With Calendar
- Create tasks for meeting follow-ups
- Set due dates based on calendar events
- Reference meeting in task notes

### With Gmail
- Create tasks from email action items
- Include email subject/link in task notes
- Set due date based on email urgency

### Task Hierarchies
- Use subtasks for breaking down large tasks
- Parent tasks auto-complete when all subtasks done
- Max nesting depth is 1 level (tasks → subtasks)
