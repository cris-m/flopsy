---
name: executing-plans
compatibility: Designed for FlopsyBot agent
description: Execute implementation plans task-by-task with test-driven discipline. Use when a plan has been written and it is time to carry it out step by step.
---

# Executing Plans

A disciplined approach to carrying out implementation plans one task at a time, with verification at each step.

## When to Use This Skill

- A plan (from the planning or writing-plans skill) is ready to execute
- The user says "start implementing" or "execute the plan"
- A multi-step implementation needs to proceed in a controlled, verifiable way

## Core Principle: One Task at a Time

Never try to implement the entire plan in a single pass. Execute one task, verify it works, then move to the next. This catches errors early before they cascade.

## Execution Workflow

### Step 1: Read the Plan

Before starting, read the full plan and understand:
- The order of tasks and their dependencies
- What each task's acceptance criteria are
- Which tasks can run in parallel and which must be sequential

### Step 2: Pick the Next Task

Choose the next task based on:
- **Dependencies first**: If task B depends on task A, do A first
- **Unblocked tasks**: Among tasks with no dependencies, start with the highest priority
- **Mark as in progress**: Note that this task is being worked on

### Step 3: Implement

Carry out the task:
- Write the code, create the file, or make the change
- Keep the scope tight: do only what this task requires
- If you discover something that changes the plan, note it but do not deviate without checking with the user

### Step 4: Verify (Test-Driven)

Before moving on, verify the task is done:
- **Unit level**: Does the code compile or parse correctly?
- **Functional level**: Does the feature work as expected? Run relevant tests.
- **Integration level**: Does this change break anything that was already working?

If verification fails, fix the issue before moving to the next task.

### Step 5: Mark as Complete and Move On

Once verified:
- Mark the task as complete in the plan
- Update any state that the next task depends on
- Pick the next task and repeat

## Handling Surprises

During execution, you may encounter:

| Surprise | How to Handle |
|----------|---------------|
| A dependency is missing | Note it, do not proceed past it; inform the user |
| The task is larger than estimated | Break it into sub-tasks; re-estimate |
| The approach does not work | Pause, reassess, consider alternatives (brainstorming) |
| A test fails after your change | Debug and fix before moving on; do not skip |
| The plan is outdated | Flag the discrepancy; ask the user whether to update the plan or proceed anyway |

## Progress Reporting

After each task completion, briefly report:
- What was done
- Whether tests passed
- What comes next

Example:
```
Completed: Created the database migration for the users table.
Tests: Migration runs successfully; schema matches the expected structure.
Next: Implement the user registration endpoint.
```

## Guidelines

- Never skip verification. A broken task will compound into broken subsequent tasks.
- If a task takes significantly longer than estimated, stop and check in with the user rather than pushing through silently.
- Keep the plan document updated as you go; future sessions will need to know where things stand.
- Pair this skill with writing-plans (to create the plan) and verification (to confirm completion).
