---
name: learning
compatibility: Designed for FlopsyBot agent
description: Continuous learning system that captures insights, tracks knowledge growth, and surfaces relevant lessons from past experience. Use when the user learns something new or wants to review past learnings.
---

# Learning

A continuous learning system that captures, organizes, and surfaces insights over time to support growth and avoid repeating mistakes.

## When to Use This Skill

- User says "I learned that ..." or "remember this for later"
- User wants to review past learnings or insights
- A task is completed and lessons should be captured
- The system wants to surface a relevant past lesson before starting a task

## How It Works

Learnings are stored in `.flopsy/learning/reflection.json` and updated after significant tasks or at the end of sessions. Each learning entry contains:

- **topic**: The subject or domain the insight relates to
- **insight**: The specific lesson or observation
- **context**: When and why this was learned
- **date**: When the entry was recorded

## Workflow

### Capturing a Learning
1. Identify the topic and the specific insight
2. Write the insight as a concise, actionable statement (e.g., "Always check X before doing Y")
3. Record the context (what task or situation prompted this)
4. Append to the learning store by updating the reflection file (`.flopsy/learning/reflection.json`) with a new entry; see the tool catalog for the current writer tool if available

### Reviewing Learnings
1. Load the current learning store
2. Filter by topic if the user has a specific area in mind
3. Present the most relevant or recent entries
4. Suggest which learnings might apply to the current task

### Surfacing Lessons Before a Task
Before starting a complex task, check the learning store for entries tagged with a related topic. Present any relevant lessons as a "heads up" before proceeding.

## Learning Types

| Type | When to use | content field | context field |
|------|-------------|---------------|---------------|
| `correction` | User corrects you | "[wrong] → [right]" | What triggered it |
| `win` | Strategy/tool combo worked well | What succeeded | The situation |
| `observation` | Pattern noticed about user or system | The pattern | Evidence |
| `gap` | Knowledge gap — you didn't know something | What you didn't know | How it surfaced |
| `error` | Tool, MCP, command, or API fails | "toolName: one-line failure" | Exact error output + what was attempted + suggested fix |
| `feature_request` | User wants a capability that doesn't exist | What they wanted to do | Their use-case + complexity estimate (simple/medium/complex) |

**Key distinction:** `gap` = "I don't know X", `feature_request` = "Flopsy can't do X yet". Use `error` instead of `gap` when there's an actual failure output to record.

## Guidelines

- Learnings should be specific and actionable, not vague observations
- Limit entries to a manageable number; periodically review and consolidate
- Tag entries with topics so they can be retrieved contextually
- The learning system is a complement to skills, not a replacement; new learnings should be promoted to skill documentation when they become general best practices
