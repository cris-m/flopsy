---
name: verification
compatibility: Designed for FlopsyBot agent
description: Verify task completion before claiming it is done. Use after finishing any implementation, change, or action to confirm everything works as expected.
---

# Verification

A disciplined checklist-based approach to confirming that work is actually done before reporting it as complete.

## When to Use This Skill

- You have finished implementing something and are about to tell the user it is done
- A task from a plan has been completed and needs sign-off before moving to the next one
- The user says "make sure it works" or "test this"
- Any destructive or irreversible action has been taken and needs to be confirmed

## Why Verify Before Claiming Done

It is easy to convince yourself that something works because you just wrote it. Verification forces you to check from the outside rather than assuming from the inside. This catches:
- Code that compiles but does not behave correctly
- Files that were written to the wrong path
- Actions that partially succeeded but left things in an inconsistent state
- Regressions introduced by the change

## Verification Checklist

### For Code Changes
- [ ] Does the code compile or parse without errors?
- [ ] Do existing tests still pass?
- [ ] Does the new functionality work when exercised manually or via a test?
- [ ] Are there any new warnings or deprecation notices?
- [ ] Is the change isolated to the intended scope? (no unintended files modified)

### For File Operations
- [ ] Does the target file exist at the expected path?
- [ ] Does the file content match what was intended?
- [ ] Are permissions correct?
- [ ] Were any other files accidentally modified?

### For Messages or Emails Sent
- [ ] Was the message delivered successfully? (check tool response)
- [ ] Was it sent to the correct recipient?
- [ ] Does the content match what the user asked for?

### For Actions (calendar events, tasks, etc.)
- [ ] Was the action confirmed by the tool response?
- [ ] Does the created item have the correct details? (retrieve and compare)
- [ ] Are there any conflicts with existing items?

## Verification Workflow

1. **Identify what was done**: What action or change was just completed?
2. **Select the right checklist**: Pick from the categories above (or adapt)
3. **Run the checks**: Execute each item on the checklist
4. **Report findings**: If all checks pass, confirm completion. If any fail, fix them before confirming.

## Output Format

When verification passes:
```
Verified:
- [Check 1]: passed
- [Check 2]: passed
- [Check 3]: passed
All checks passed. Task is complete.
```

When verification reveals issues:
```
Verification found issues:
- [Check 1]: passed
- [Check 2]: FAILED — [description of what is wrong]
Action: [What needs to be fixed before this can be marked complete]
```

## Guidelines

- Never skip verification on destructive actions (deletes, sends, publishes). The cost of checking is always less than the cost of an irreversible mistake.
- If a check cannot be performed (e.g., no way to confirm email delivery), note the limitation explicitly rather than assuming success.
- Verification is the last step of any task in the executing-plans workflow. It is not optional.
- If verification consistently catches the same type of error, that is a signal to improve the implementation process upstream.
