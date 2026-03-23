---
name: context-recovery
compatibility: Designed for FlopsyBot agent
description: Recover context after compaction or session restart. Use when starting a new session that continues prior work, or when context has been lost and must be reconstructed.
---

# Context Recovery

Reconstruct working context after a session boundary, compaction event, or interruption so that work can continue without loss.

## When to Use This Skill

- A new session is starting and the user references prior work ("continue where we left off")
- Context was compacted and the session needs to resume
- The system restarts and needs to pick up an in-progress task
- The user says "what were we working on?"

## Recovery Sources

Context can be recovered from several places, in order of priority:

| Source | What It Contains | How to Access |
|--------|-----------------|---------------|
| Compressed context summary | Decisions, state, pending tasks | Check session state or memory files |
| Learning store | Past insights and lessons | `.flopsy/learning/reflection.json` |
| Heartbeat state files | Last known state of monitors | `.flopsy/heartbeats/states/{name}.json` |
| Scheduler state | Scheduled task history | `.flopsy/state/proactive.json` |
| File system | Actual file contents on disk | Read files directly |
| Git history | What was committed and when | `git log`, `git diff` |

## Recovery Workflow

### Step 1: Check for a Compressed Context

Look for a session summary or compressed context document. This is the fastest path to recovery if it exists.

### Step 2: Reconstruct from State Files

If no compressed context is available:
1. Check `.flopsy/` for any state files that indicate what was in progress
2. Check git status and recent commits to understand what files were changed
3. Read any files that are likely relevant to the ongoing work

### Step 3: Ask the User (If Needed)

If state files are insufficient:
- Ask the user what they were working on
- Ask for any key details that cannot be inferred from the file system

### Step 4: Rebuild the Working Context

Produce a recovery summary:

```markdown
## Recovered Context

### What Was in Progress
[Description of the task or project]

### Where We Left Off
[Specific point in the work where the session ended]

### What Needs to Happen Next
- [ ] Next step 1
- [ ] Next step 2

### Relevant Files
- [file path]: [brief description of its role]
```

### Step 5: Continue

Present the recovered context to the user for confirmation, then proceed with the next steps.

## Guidelines

- Recovery should be fast; do not re-read entire codebases when a state file or git log will do
- If recovery is partial (some context is missing), be transparent about what is unknown rather than guessing
- After successful recovery, consider saving a fresh compressed context so that future recoveries are faster
- If the user has specific details about where they left off, prioritize those over inferred state
