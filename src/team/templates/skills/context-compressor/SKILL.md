---
name: context-compressor
compatibility: Designed for FlopsyBot agent
description: Compress conversation context before hitting token limits. Use when the context window is getting large, a session needs to continue across a boundary, or important state must be preserved in fewer tokens.
---

# Context Compressor

Reduce the size of the active conversation context while preserving all critical information, enabling longer sessions and smoother handoffs.

## When to Use This Skill

- The conversation context is approaching token limits and needs to continue
- A long session is being handed off and only the essential state needs to carry forward
- The user asks to "summarize so far" or "compress the context"
- Before delegating to a subagent that needs context but not the full history

## What Gets Preserved

When compressing, retain:
- **Decisions made**: Any choices the user or system has committed to
- **Current state**: Where things stand right now (e.g., "file X has been edited, file Y has not")
- **Open tasks**: Work that has been started but not finished
- **Key facts**: Information that will be needed for upcoming steps
- **Errors encountered**: Problems that have already been hit, so they are not repeated

## What Gets Dropped

Safe to discard during compression:
- Exploratory discussion that did not lead to a decision
- Full text of files or documents that can be re-read if needed
- Intermediate reasoning steps that led to a conclusion already captured
- Redundant restatements of information already in the summary

## Compression Workflow

### Step 1: Identify the Boundary

Determine what needs to survive the compression:
- What is the user going to do next?
- What context does that next step require?

### Step 2: Extract Critical State

Walk through the conversation and pull out:
- All decisions and their rationale
- Current file states (changed, unchanged, not yet touched)
- Any pending actions or open questions
- Errors or constraints discovered

### Step 3: Write the Summary

Produce a compressed context document:

```markdown
## Session Context (compressed)

### Goal
[What the overall session is trying to accomplish]

### Decisions Made
- Decision 1: [what was decided and why]
- Decision 2: [what was decided and why]

### Current State
- [File or resource]: [status]
- [File or resource]: [status]

### Pending
- [ ] Task that still needs to be done
- [ ] Another pending task

### Key Constraints
- [Constraint discovered during this session]

### Errors Encountered
- [Error and how it was resolved, or that it remains open]
```

### Step 4: Verify Completeness

Before discarding the original context, confirm that the compressed version contains everything needed to continue. Ask: "If I only had this summary, could I pick up where we left off?"

## Guidelines

- Compression is lossy by nature. When in doubt, keep the information rather than dropping it.
- Date the compressed context so it is clear when it was created.
- If the user continues the session after compression, reference the compressed summary at the top of the new context.
- Compression works best when done proactively, before the context limit is hit, rather than reactively after it is exceeded.
