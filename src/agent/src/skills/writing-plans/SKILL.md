---
name: writing-plans
compatibility: Designed for FlopsyBot agent
description: Create detailed implementation plans with tasks, dependencies, and acceptance criteria. Use when a project or feature needs a written plan before coding begins.
---

# Writing Plans

Create detailed, actionable implementation plans that serve as the roadmap for coding and execution.

## When to Use This Skill

- User says "write a plan for ..." or "plan out this feature"
- A project has been scoped (via brainstorming or planning) and needs a concrete written plan
- Before starting implementation, to ensure everyone (including future sessions) knows what to do and in what order

## Difference from Planning

The `planning` skill is for strategic thinking: defining goals, decomposing into milestones, and prioritizing. This skill is for the output artifact: the written plan document that will be executed. Planning produces the thinking; writing-plans produces the document.

## Plan Document Structure

```markdown
# [Project or Feature Name] — Implementation Plan

## Overview
[2-3 sentences on what is being built and why]

## Prerequisites
- [ ] [Dependency or setup that must be done first]
- [ ] [Another prerequisite]

## Tasks

### Phase 1: [Phase Name]

#### Task 1.1: [Task Title]
- **Goal**: [What this task produces]
- **Acceptance Criteria**: [How you know it is done — be specific]
- **Estimated Effort**: [Time estimate]
- **Dependencies**: [What must be done before this task]
- **Notes**: [Any gotchas or context]

#### Task 1.2: [Task Title]
[Same structure]

### Phase 2: [Phase Name]
[Same structure]

## Testing Strategy
[How the overall feature will be tested end-to-end]

## Rollback Plan
[What to do if something goes wrong after deployment]

## Definition of Done
[The criteria that must ALL be met for this project to be considered complete]
```

## Writing Good Acceptance Criteria

Acceptance criteria must be:
- **Specific**: "The login endpoint returns a 200 with a JWT token" not "login works"
- **Testable**: You can write a test or manually verify the criterion
- **Binary**: Either it passes or it does not; no ambiguity

| Bad | Good |
|-----|------|
| "It works" | "The API returns status 200 and a valid JSON response" |
| "Looks good" | "The button is styled with the primary color and is clickable" |
| "No bugs" | "All existing tests pass and no new regressions are detected" |

## Dependency Mapping

Before writing the plan, map task dependencies:
1. List all tasks
2. For each task, identify which other tasks must complete first
3. Order tasks so that dependencies come before dependents
4. Identify tasks that can run in parallel (no shared dependency)

## Guidelines

- A plan is a living document. If reality diverges from the plan during execution, update the plan rather than silently deviating.
- Include time estimates even if they are rough. They serve as a baseline for identifying when something is taking longer than expected.
- The "Definition of Done" section is critical. Without it, there is no clear signal that the project is complete.
- Save the plan to a persistent location (file, Notion, Obsidian) so it survives session boundaries.
- Pair this skill with executing-plans to carry out the plan once it is written.
