---
name: debugging
compatibility: Designed for FlopsyBot agent
description: Systematic debugging methodology for code issues. Use when code doesn't work as expected, tests fail mysteriously, or you need to trace through complex behavior.
---

# Debugging

A methodical approach to finding and fixing bugs when code doesn't behave as expected.

## When to Use This Skill

- Tests are failing and you don't know why
- Code produces wrong output or throws unexpected errors
- User reports a bug but you can't reproduce it
- Integration between components is broken

## How to Run Commands

**Always use the `Bash` tool to run commands.** Never tell the user to run commands themselves — you have the `Bash` tool.

## Workflow

### Step 1: Reproduce the Issue
**Goal:** Get a reliable way to trigger the bug.

1. Read the error message carefully - what file, line, and type of error?
2. Identify minimal reproduction - can you reproduce in a test?
3. Document expected vs. actual behavior

### Step 2: Gather Information
**Goal:** Understand the context around the bug.

What to check:
- **Stack trace**: Read from bottom to top
- **Recent changes**: `git log -5 --oneline`
- **Input data**: What values are being passed?
- **Environment**: Does it fail in dev? prod?

Commands:
```bash
git log --oneline -10
git log -p path/to/file.ts
grep -r "functionName" src/
```

### Step 3: Form Hypothesis
**Goal:** Make a specific, testable guess about the cause.

Good hypothesis:
- "I think X is failing because Y is null when it should be an array"
- "The error happens when the API returns a 404, not a 200"

Bad hypothesis:
- "Something is wrong with the database"
- "The code is broken"

### Step 4: Test Hypothesis
**Goal:** Prove or disprove your hypothesis.

Techniques:
- Add logging at key points
- Write a failing test to isolate the bug
- Simplify inputs to smallest failing case
- Binary search: comment out half the code

### Step 5: Fix and Verify
**Goal:** Apply the fix and confirm it works.

1. Make the minimal change to fix root cause
2. Run the failing test - does it pass now?
3. Run ALL tests - did you break something else?
4. Clean up debug code (remove console.logs)
5. Document the fix (commit message or comments)

## Debugging Strategies by Error Type

### "Cannot read property 'X' of undefined"
1. Trace back - where did undefined come from?
2. Add null check OR fix the source of undefined
3. Consider: is this an async timing issue?

### "TypeError: X is not a function"
1. Check what X actually is: `console.log(typeof X)`
2. Verify import is correct
3. Check if function is called before it's defined

### Infinite loop / Timeout
1. Add logging inside loop - is exit condition ever true?
2. Check loop counter - is it incrementing correctly?
3. Look for off-by-one errors

### Test fails intermittently
1. Race condition? Add await or proper synchronization
2. Shared state? Isolate tests or clean up between runs
3. Timing-dependent? Add proper waits, not arbitrary delays

### "Cannot find module" or import errors
1. Check if file exists at the import path
2. Verify file extension matches (`.ts` vs `.js`)
3. Check if module is installed: `npm list <package>`

## Guidelines

- Don't change code randomly hoping it fixes the bug
- If stuck after 3 hypotheses, gather more information
- Keep a debugging log in `/workspaces/coder/debug-{issue}.md` for complex issues
- After fixing, search for similar patterns elsewhere that might have the same bug
- If you can't reproduce the bug, you can't verify the fix

## Common Debugging Tools

| Tool | Purpose | Command |
|------|---------|---------|
| Stack trace | Find where error originated | Read error message carefully |
| Git log | See recent changes | `git log --oneline -10` |
| Git blame | Who changed this line? | `git blame path/to/file.ts` |
| Grep | Find all uses of a function | `grep -r "functionName" src/` |
| Tests | Isolate behavior | Write a minimal failing test |
| Console logs | Trace execution flow | Add strategic `console.log()` |
| Type checker | Catch type errors | `npm run type-check` or `tsc --noEmit` |
