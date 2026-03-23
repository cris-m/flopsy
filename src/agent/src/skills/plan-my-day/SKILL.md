---
name: plan-my-day
compatibility: Designed for FlopsyBot agent
description: Generate an energy-optimized, time-blocked daily plan. Gathers calendar, tasks, and priorities via productivity tools, then builds an hour-by-hour schedule matched to the user's energy windows. Triggered by user request ("plan my day") or as an add-on to morning briefing.
---

# Plan My Day

Build a concrete, time-blocked daily plan based on real calendar data, current priorities, and energy windows — not a template dump.

## When to Use This Skill

- User says "plan my day", "block my schedule", "what should I work on today?"
- User says "/plan-my-day" or "/plan-my-day YYYY-MM-DD"
- Morning briefing was just delivered and user asks for a plan
- User seems overwhelmed with tasks and needs structure

## Energy Windows

Match task difficulty to the user's natural energy. Learn these from `USER.md` and adjust over time.

| Window | Default Time | Best For |
|--------|-------------|----------|
| Peak | 9am–12pm | Hardest problems — deep work, creative thinking, complex code |
| Secondary | 1pm–4pm | Focused work — meetings, reviews, structured tasks |
| Recovery | 12pm–1pm, 3pm–3:30pm | Breaks — lunch, walk, coffee, quick admin |
| Wind-down | 4pm–6pm | Lighter tasks — emails, planning, cleanup, reading |

Check `USER.md` for the user's actual rhythm. Some people peak at 6am, others at 10pm. Don't assume.

## Process

### Step 1: Gather (PARALLEL — single turn)

```
task("productivity", "Today's full calendar with times, locations, attendees")
task("productivity", "All tasks: overdue, due today, due this week. Include priority and project.")
task("productivity", "Active reminders for today and tomorrow")
```

Also read:
- `USER.md` — energy preferences, typical schedule, work style
- `WORKING.md` — current focus areas, ongoing projects

Run ALL in a single turn. Wait for results.

### Step 2: Identify Top 3

Ask yourself — not the user:
- What **MUST** happen today? (deadlines, meetings, commitments)
- What **moves the needle most** on their current focus? (from WORKING.md)
- What's been **stuck or overdue** the longest? (debt items)

Pick exactly 3 priorities. If you can't narrow it down, pick the 3 with the nearest deadlines or highest impact.

### Step 3: Build Time Blocks

Rules:
1. **Fixed commitments first** — meetings, calls, appointments lock in their slots
2. **Hardest priority → peak energy window** — the thing they're avoiding goes when they're sharpest
3. **Group similar tasks** — batch emails, batch reviews, batch admin
4. **Buffer between blocks** — 15min between focused blocks, 30min between meetings
5. **Never schedule 100%** — leave 20% unblocked for overflow and surprise tasks
6. **Protect personal time** — meals, breaks, exercise are non-negotiable blocks
7. **Morning priming** — first 30min is for coffee, inbox scan, not deep work (unless user prefers otherwise)

### Step 4: Apply Constraints

Before finalizing, check:
- No double-bookings with calendar events
- Travel time between locations (if any in-person events)
- Lunch isn't squeezed between back-to-back meetings
- End-of-day buffer before any evening commitments

## Output

Deliver the plan as a natural, scannable message — not a template dump.

**VOICE VARIETY**: Let the day shape how you present it. Packed days need urgency. Light days need focus suggestions. Never format the same way twice.

**What a GOOD daily plan includes** (structure, not script):

1. Today's mission — one sentence capturing the day's goal
2. Top 3 priorities — specific outcomes, not vague tasks
3. Time-blocked schedule — hour-by-hour with focus areas and task lists
4. Success criteria — what "done" looks like at end of day
5. Decision filter — "before doing X, ask: is this one of my top 3?"

**Annotated example** (vary the words, keep the structure):

```
[← ONE-LINE MISSION — what makes today a win]
Today's about shipping the API refactor and getting ahead of Thursday's demo.

[← TOP 3 — specific, outcome-oriented, not vague]
🎯 Top 3:
1. API refactor PR merged and passing CI
2. Demo slide outline in shared doc
3. Clear the 3-day-old expense report

[← TIME BLOCKS — matched to energy, respects calendar]
📋 The plan:

8:30–9:00  ☕ Morning priming — inbox scan, Slack catch-up
9:00–11:30 🔥 Deep work — API refactor (peak energy, no meetings)
11:30–12:00 📬 Quick admin — expense report, reply to Sarah's email
12:00–1:00  🍜 Lunch break
1:00–2:00  📅 Design review (calendar)
2:00–3:30  💻 Demo outline — structure slides, pick key metrics
3:30–3:45  ☕ Break
3:45–4:30  👀 PR reviews (2 pending)
4:30–5:00  📝 Plan tomorrow + update WORKING.md

[← SUCCESS CRITERIA — know when you're done]
✅ Win conditions:
- [ ] API refactor PR merged
- [ ] Demo outline shared with team
- [ ] Expense report submitted

[← DECISION FILTER — throughout the day]
⚡ Before starting anything new: "Is this one of my top 3? No? It waits."
```

## After Delivering

- Save the plan to `WORKING.md` — update the "Today's Focus" section
- If using Obsidian, save to `/daily/{YYYY-MM-DD}.md`
- Log to `/memory/{YYYY-MM-DD}.md`

## Integration with Daily Rhythm

When triggered alongside a morning briefing:
- The morning briefing gathers and presents (what's happening today)
- Plan-my-day goes further: organizes and schedules (how to tackle it)
- Don't duplicate info — reference what the briefing already covered

## Tips

- Don't schedule the first and last 30 minutes — those are buffer
- Put the task they're procrastinating on in the peak window
- If the day has 4+ hours of meetings, explicitly mark remaining focus time as precious
- Group all communication (email, Slack, messages) into 2 fixed windows, not throughout the day
- Mid-day check: if a plan falls apart by noon, rebuild the afternoon — don't abandon structure

## Don't

- Dump a template without real data — always gather first
- Schedule every minute — leave 20% open
- Ignore existing calendar events — those are fixed constraints
- Make it longer than 60 seconds to read
- Use the same opening phrase as the morning briefing

## Do

- Use real task names from their actual task list
- Match blocks to energy levels
- Call out the single most important task explicitly
- Include a decision filter they can reference throughout the day
- Offer to adjust mid-day if things shift
