---
name: planning
compatibility: Designed for FlopsyBot agent
description: Strategic planning for tasks and projects. Use when the user wants to plan a project, break down a goal into steps, prioritize work, or create a roadmap.
---

# Planning

Structured strategic planning to turn goals into actionable plans with clear milestones and priorities.

## When to Use This Skill

- User says "help me plan ..." or "I need a plan for ..."
- A project or goal needs to be broken into concrete steps
- User wants to prioritize work or create a roadmap
- A task is too large or vague to act on directly

## Planning Framework

### Step 1: Define the Goal

Before planning, clarify:
- **What** is the desired outcome?
- **Why** does it matter? (motivation and success criteria)
- **When** does it need to be done? (deadline or timeframe)
- **Who** is involved? (stakeholders, dependencies)

### Step 2: Decompose into Milestones

Break the goal into 3-7 milestones. Each milestone should be:
- Independently verifiable (you can confirm it is done)
- Time-boxed (has an estimated completion date)
- A meaningful chunk of progress toward the goal

### Step 3: Break Milestones into Tasks

Each milestone becomes a list of concrete tasks:
- Each task is actionable in a single session
- Tasks have clear acceptance criteria
- Dependencies between tasks are noted

### Step 4: Prioritize

Use one of these frameworks:
- **MoSCoW**: Must have / Should have / Could have / Won't have (this time)
- **Effort vs. Impact**: Plot tasks on a 2x2 grid; start with high-impact, low-effort items
- **Critical Path**: Identify tasks that block others; those go first

### Step 5: Estimate and Schedule

Assign rough time estimates to each task. Build a schedule that accounts for:
- Parallel vs. sequential work
- Buffer time for unexpected issues
- Dependencies and waiting periods

## Plan Output Format

Deliver plans in this structure:

```markdown
# [Project Name] Plan

## Goal
[Clear statement of what success looks like]

## Milestones

### Milestone 1: [Name] — Target: [Date]
- [ ] Task 1.1: [description] (est: X hours)
- [ ] Task 1.2: [description] (est: X hours)

### Milestone 2: [Name] — Target: [Date]
- [ ] Task 2.1: [description] (est: X hours)
- [ ] Task 2.2: [description] (est: X hours)

## Risks
- Risk 1: [description] — Mitigation: [approach]
- Risk 2: [description] — Mitigation: [approach]

## Next Step
[The single most important action right now]
```

## Guidelines

- Plans should be actionable, not aspirational. If a task cannot be started today, break it further until the first step is concrete.
- Always include a "Next Step" section so the user knows exactly what to do after reading the plan.
- Revisit and adjust plans as new information emerges; a plan is a living document.
- For large projects, save the plan to a persistent location (Notion, Obsidian, or a file) so it can be tracked and updated over time.
- Pair planning with the writing-plans skill when the output needs to be a detailed implementation document.
