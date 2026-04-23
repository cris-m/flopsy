---
name: code-review
compatibility: Designed for FlopsyBot agent
description: Systematic code review methodology covering correctness, style, performance, and security. Use when the user wants their code reviewed or wants to review someone else's code.
---

# Code Review

A structured approach to reviewing code for correctness, maintainability, performance, and security.

## When to Use This Skill

- User says "review this code" or "check my PR"
- A pull request needs a thorough review before merging
- User wants feedback on code quality or potential bugs

## Review Layers

Perform reviews in this order, from high-level to low-level:

### Layer 1: Architecture and Design
- Does the code solve the right problem?
- Is the approach appropriate for the scale and context?
- Are there simpler alternatives that would work?
- Does it fit the existing codebase patterns and conventions?

### Layer 2: Correctness
- Are there logical errors or edge cases that are not handled?
- Do conditionals cover all branches?
- Is error handling present and appropriate?
- Are async operations properly awaited or chained?
- Are there off-by-one errors, null pointer risks, or type mismatches?

### Layer 3: Security
- Is user input validated and sanitized?
- Are secrets, tokens, or credentials ever hardcoded or logged?
- Are SQL queries parameterized (no string concatenation for queries)?
- Are permissions and access checks in place?
- Are dependencies up to date and free of known vulnerabilities?

### Layer 4: Performance
- Are there unnecessary re-renders, redundant API calls, or N+1 queries?
- Is caching used where appropriate?
- Are large data sets paginated or streamed?
- Are expensive operations moved out of tight loops?

### Layer 5: Style and Maintainability
- Is the code readable and well-named?
- Are functions focused (single responsibility)?
- Is there adequate documentation for non-obvious logic?
- Are there consistent patterns across the file and module?
- Is dead code removed?

## Review Output Format

Structure feedback as:

```markdown
## Summary
[1-2 sentence overall assessment: ready to merge, needs changes, etc.]

## Critical (must fix before merge)
- **[file:line]** Issue description. Why it matters. Suggested fix.

## Suggestions (nice to have)
- **[file:line]** Minor improvement or style note.

## Positive
- [What the code does well — always include at least one]
```

## Guidelines

- Lead with the summary so the author knows the verdict immediately
- Be specific: point to the file and line number, not just a general observation
- Explain WHY something is a problem, not just WHAT is wrong
- Suggest concrete fixes when possible
- Separate critical issues (blockers) from nice-to-haves clearly
- Never reject code solely on style preferences; use the codebase's established conventions as the standard
- If the code is good, say so explicitly
