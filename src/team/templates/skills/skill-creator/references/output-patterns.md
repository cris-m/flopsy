# Output Patterns

Use these patterns when skills need to produce consistent, high-quality output.

## Template Pattern

Provide templates for output format. Match strictness level to requirements.

### Strict Requirements (API responses, data formats)

```text
## Report Structure

ALWAYS use this exact template:

# [Analysis Title]

## Executive Summary
[One-paragraph overview of key findings]

## Key Findings
- Finding 1 with supporting data
- Finding 2 with supporting data
- Finding 3 with supporting data

## Recommendations
1. Specific actionable recommendation
2. Specific actionable recommendation
```

### Flexible Guidance (when adaptation is useful)

```text
## Report Structure

Sensible default format—use judgment to adapt:

# [Analysis Title]

## Executive Summary
[Overview]

## Key Findings
[Adapt sections based on discoveries]

## Recommendations
[Tailor to specific context]

Adjust sections as needed for the analysis type.
```

## Examples Pattern

For skills where output quality depends on seeing examples, provide input/output pairs.

### Commit Message Format

**Example 1:**
- Input: Added user authentication with JWT tokens
- Output:
```
feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware
```

**Example 2:**
- Input: Fixed bug where dates displayed incorrectly in reports
- Output:
```
fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation
```

**Style guide:** `type(scope): brief description`, then detailed explanation.

### API Response Format

**Example 1:**
- Input: User requests current weather
- Output:
```json
{
  "success": true,
  "data": {
    "temperature": 72,
    "condition": "sunny",
    "humidity": 45
  }
}
```

**Example 2:**
- Input: Invalid location provided
- Output:
```json
{
  "success": false,
  "error": {
    "code": "INVALID_LOCATION",
    "message": "Location not found"
  }
}
```

## Structured Data Pattern

For skills that output structured data, define the schema clearly.

### Schema Definition

```yaml
# Task output schema
task:
  id: string (required)
  title: string (required, max 100 chars)
  status: enum [pending, in_progress, completed]
  priority: enum [low, medium, high]
  due_date: ISO 8601 date (optional)
  tags: array of strings (optional)
```

### With Validation Rules

```text
## Output Requirements

1. All dates in ISO 8601 format (YYYY-MM-DD)
2. IDs must be UUIDs
3. Amounts as integers (cents, not dollars)
4. Names trimmed, no leading/trailing whitespace
5. Arrays sorted alphabetically unless order matters
```

## Key Takeaway

Examples help the agent understand desired style and detail level more clearly than descriptions alone. When in doubt, show don't tell.
