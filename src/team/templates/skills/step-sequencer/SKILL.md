---
name: step-sequencer
compatibility: Designed for FlopsyBot agent
description: Persistent multi-step execution that survives gateway resets. Detects complex requests, proposes a step plan, waits for user approval, persists state to disk, and advances steps across heartbeats with failure recovery. Use when a request has 3+ actions, sequential dependencies, or high scope.
---

# Step Sequencer

Persistent, heartbeat-driven execution of multi-step plans. Unlike the executing-plans skill (which runs within a single session), the step sequencer writes progress to disk after every step — so if the gateway restarts mid-task, the next heartbeat picks up exactly where it left off.

## When to Use This Skill

- Request requires 3+ distinct actions with dependencies between them
- Output from one step feeds into the next (research → analyze → write)
- Task will likely span multiple sessions or heartbeat cycles
- High-risk work that benefits from checkpointed progress
- User says "step by step", "break this down", or "one at a time"
- Request contains "set up", "migrate", "implement from scratch", "full X"

## When NOT to Use

- Task can be done in a single pass — just do it
- Steps are independent with no dependencies — delegate them in parallel instead
- The user wants a plan document but not automated execution — use writing-plans instead

## How It Relates to Other Skills

| Skill | Role |
|-------|------|
| planning | Creates the strategic plan (what to do and in what order) |
| writing-plans | Writes the plan as a document |
| **step-sequencer** | **Persists and executes the plan across heartbeats with crash recovery** |
| executing-plans | Executes a plan within a single session (no persistence) |
| delegation | Hands individual steps to subagents |
| verification | Confirms each step's output before advancing |

Use planning or writing-plans to design the plan, then step-sequencer to execute it durably. For simple plans that fit in one session, executing-plans is sufficient.

---

## Workflow

### 1. Detect Complexity

Evaluate the request before proposing:

| Signal | Meaning |
|--------|---------|
| 3+ distinct actions | Multi-step |
| "then", "after", "first...then" | Sequential dependency |
| Step B needs output from step A | Output dependency |
| Many files, destructive ops, migration | High scope or risk |
| "step by step", "break this down" | User requests steps |

If none of these apply, skip the sequencer and execute directly.

### 2. Propose the Plan

Present the steps to the user **before doing anything**:

```
I'll break this into 4 steps:

1. Research competitors — web search, produces research/competitors.md
2. Analyze patterns — needs step 1, produces research/analysis.md
3. Draft strategy — needs step 2, produces research/strategy.md
4. Create action items — needs step 3, produces research/actions.md

Use a delay between steps? (Recommended for API-heavy work to avoid rate limits)

Want me to proceed?
```

**Wait for approval.** If the user modifies the plan, update and re-confirm.

### 3. Persist State

After approval, save the plan state to `plans/sequencer/{plan-id}.json` using `write_file`:

```json
{
  "id": "competitor-research-20260213",
  "title": "Competitor Research",
  "createdAt": "2026-02-13T10:00:00Z",
  "status": "IN_PROGRESS",
  "stepDelayMinutes": 0,
  "currentStep": 0,
  "plan": {
    "steps": {
      "step-1": {
        "title": "Research competitors",
        "instruction": "Search the web for top 5 competitors. For each: pricing, features, audience, recent news. Save to research/competitors.md with URLs.",
        "delegate": "swarm",
        "requiredOutputs": ["research/competitors.md"]
      },
      "step-2": {
        "title": "Analyze patterns",
        "instruction": "Read research/competitors.md. Identify: common features, pricing patterns, gaps in the market, differentiation opportunities. Save to research/analysis.md.",
        "delegate": "swarm",
        "requires": ["step-1"],
        "requiredOutputs": ["research/analysis.md"]
      },
      "step-3": {
        "title": "Draft strategy",
        "instruction": "Using research/analysis.md, write a competitive strategy document. Include: positioning, feature priorities, pricing recommendation, go-to-market approach. Save to research/strategy.md.",
        "delegate": "swarm",
        "requires": ["step-2"],
        "requiredOutputs": ["research/strategy.md"]
      },
      "step-4": {
        "title": "Create action items",
        "instruction": "Extract concrete action items from research/strategy.md. Each item should have: priority (P0/P1/P2), owner, estimated effort, and deadline. Save to research/actions.md.",
        "delegate": "planner",
        "requires": ["step-3"],
        "requiredOutputs": ["research/actions.md"]
      }
    }
  },
  "stepQueue": ["step-1", "step-2", "step-3", "step-4"],
  "stepRuns": {},
  "blockers": [],
  "artifacts": []
}
```

The `plan.steps` object holds step definitions keyed by ID. The `stepQueue` array defines execution order. Runtime state goes in `stepRuns` (keyed by step ID), keeping definitions and execution state cleanly separated.

**Persist after every state change.** This is what makes the sequencer crash-recoverable.

### 4. Execute the Current Step

For each step:

1. Read state from `plans/sequencer/{plan-id}.json`
2. Find the current step ID from `stepQueue[currentStep]`, look up its definition in `plan.steps`
3. Check that all `requires` steps are marked DONE in `stepRuns`
4. If `stepDelayMinutes > 0`, check that enough time has passed since the last step finished
5. Update step status to `IN_PROGRESS`, persist state
6. Delegate to the specified subagent using `task()`:

```
task("{delegate}", "
  Step {N} of {total}: {title}

  Context: Previous steps completed — {list completed step titles and their outputs}

  Instruction: {instruction}

  Required outputs: {requiredOutputs or 'None'}

  Save all files relative to the workspace root.
")
```

7. When the subagent returns, check `requiredOutputs` — do all files exist?
8. If yes → mark `DONE`, record completion time, advance `currentStep`, persist
9. If no → mark `FAILED`, record error, persist (see Failure Recovery below)
10. If more steps remain and no delay needed → continue to next step
11. If all steps done → mark plan `DONE`, notify user

### 5. Heartbeat Integration

The sequencer runs inside the existing heartbeat cycle — no separate scripts or cron jobs.

On each heartbeat (or when the user sends a message):

1. Check `plans/sequencer/` for any files with `status: "IN_PROGRESS"`
2. For each active plan, run the execution flow from step 4
3. If a step was `IN_PROGRESS` for more than 10 minutes with no update, treat it as a stale crash — reset to `PENDING` and re-execute
4. Report blocked plans in the heartbeat output

This is how the sequencer survives gateway resets: the heartbeat reads persisted state and resumes.

### 6. Completion

When all steps are done:

1. Set plan status to `DONE`
2. Notify the user with a summary of what was produced
3. Update `memory/WORKING.md` with the completion
4. Log to daily memory

---

## Failure Recovery

When a step fails, do not stop and ask the user. Try to recover autonomously:

1. **Retry once** — might be transient (network error, rate limit)
2. **Try an alternative** — different source, different tool, different approach
3. **Fail and record** — only after retry + alternative both fail

After marking a step `FAILED`:
- If `tries < 3`: reset to `PENDING` and re-execute with a troubleshoot prompt:

```
task("{delegate}", "
  RETRY — Step {N}: {title} (attempt {tries + 1})

  Previous attempt failed: {error}

  Please troubleshoot and try a different approach.
  Original instruction: {instruction}
")
```

- If `tries >= 3`: add the failure reason to `blockers`, set plan status to `BLOCKED`, and notify the user with what failed and what was tried

---

## User Interactions

| User Says | Action |
|-----------|--------|
| "what's the status?" / "how's the plan going?" | Read active plans, report step progress |
| "skip step 3" | Mark step 3 as DONE (skipped), advance |
| "cancel the plan" | Set status to `CANCELLED`, stop execution |
| "pause" / "hold off" | Set status to `BLOCKED` with reason "paused by user" |
| "resume" / "continue" | Clear blockers, set status to `IN_PROGRESS` |
| "add a step after step 2" | Insert new step, update the steps array |
| "show me what step 2 produced" | Read the requiredOutputs files from step 2 |

---

## State Location

```
~/.flopsy/plans/sequencer/
├── competitor-research-20260213.json
├── api-migration-20260210.json
└── ...
```

Plan IDs are `{slugified-title}-{YYYYMMDD}`. Completed plans are kept for 30 days for reference.

---

## Guidelines

- Always propose and wait for approval before starting a multi-step plan
- Persist state to disk after every step status change — this is non-negotiable
- One step at a time — do not run steps in parallel unless they have no shared dependencies
- Step instructions must be self-contained — the subagent should not need to read the full plan
- Verify `requiredOutputs` exist before marking a step DONE (use the verification skill)
- Notify the user on plan completion, plan failure, and plan blocking — never leave them wondering
- Use `stepDelayMinutes: 2` for API-heavy plans (web search, email, social media); use `0` for local work
- If a plan has been BLOCKED for 7+ days, notify the user and suggest cancellation
- Pair with the context-recovery skill — on session restart, check for active sequencer plans
