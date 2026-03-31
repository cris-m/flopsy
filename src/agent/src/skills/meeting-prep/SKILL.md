---
name: meeting-prep
compatibility: Designed for FlopsyBot agent
description: Prepare briefings, talking points, and attendee profiles before meetings. Use when the user says "prep me for the meeting" or has an important upcoming discussion.
---

# Meeting Prep

Prepare a structured briefing so the user walks into any meeting informed, prepared, and confident.

## When to Use This Skill

- User says "prep me for the meeting with..."
- User has an upcoming interview, pitch, or negotiation
- User wants background on attendees or topics before a discussion
- Calendar event approaching that needs preparation

## Preparation Process

### Step 1: Gather Context
- What's the meeting about?
- Who's attending? (names, roles)
- What's the desired outcome?
- How much time is available?
- Is there an agenda?

### Step 2: Research Attendees
For each key attendee (use web_search):
- Role and background
- Recent work or public statements
- Communication style (if observable from public presence)
- What they care about (their priorities, not yours)

### Step 3: Prepare Content
- 3-5 talking points aligned with the meeting goal
- Key data or facts to reference
- Questions to ask (shows preparation and engagement)
- Potential objections and responses

### Step 4: Anticipate
- What questions will they ask you?
- What's the most difficult question you might face?
- What's the worst-case scenario and how to handle it?

## Output Format

```markdown
## Meeting Brief: [Topic]
**Date:** [When]
**Duration:** [How long]
**Goal:** [What you want to achieve]

### Attendees
- **[Name]** — [Role] | [Key fact about them] | [What they likely care about]
- **[Name]** — [Role] | [Key fact] | [Their priority]

### Talking Points
1. [Point] — supported by [data/fact]
2. [Point] — supported by [data/fact]
3. [Point] — supported by [data/fact]

### Questions to Ask
- [Question that shows preparation]
- [Question that advances your goal]

### Anticipated Questions
- **Q:** [What they might ask]
  **A:** [Your prepared response]

### Red Lines
- [What you will not agree to and why]

### Opening
[Suggested opening line/approach]

### Closing
[How to end the meeting with a clear next step]
```

## Guidelines

- Focus on the user's goal, not just general preparation
- Research is proportional to meeting importance — a casual sync needs less prep than an investor pitch
- Always prepare at least one thoughtful question to ask — it shows engagement
- Note what you couldn't find: "I couldn't verify [X], you may want to confirm directly"
- Pair with negotiation skill if the meeting involves a deal or difficult conversation
