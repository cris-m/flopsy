---
name: habit-tracker
compatibility: Designed for FlopsyBot agent
description: Track daily habits, streaks, and accountability using memory. Use when the user wants to monitor habits, check streaks, or get accountability nudges.
---

# Habit Tracker

Track habits, maintain streaks, and provide gentle accountability. Data is stored in memory and persists across conversations.

## When to Use This Skill

- User says "track my habits", "did I work out?", "how's my streak?"
- User reports completing a habit: "I exercised today", "I meditated"
- Daily rhythm or heartbeat check-ins that include habit status
- User asks for a weekly/monthly habit summary

## Habit Management

### Adding a Habit
When the user says "track [habit]":
1. Confirm the habit name and expected frequency (daily, weekdays, 3x/week)
2. Save to memory: `habit:[name] = { frequency, startDate, completions: [] }`

### Logging a Completion
When the user reports completing a habit:
1. Record the date in the habit's completions array
2. Update the streak count
3. Acknowledge with the current streak

### Checking Status
When asked about habits:
1. Load habit data from memory
2. Calculate current streaks, completion rates, and missed days
3. Present the dashboard

## Streak Rules

- **Daily habits:** Streak breaks if a day is missed (no completion logged by end of day)
- **Weekly habits (3x/week):** Streak breaks if fewer than target completions in a calendar week
- **Grace period:** One missed day does not reset the streak if the user has 7+ day streak (protects long streaks from accidents)

## Output Format

### Daily Check-In
```
Habits for today (March 30):

  Exercise    ✅ Done (streak: 12 days)
  Meditation  ⬜ Not yet
  Reading     ✅ Done (streak: 5 days)
  Water 2L    ⬜ Not yet

Overall: 2/4 complete
```

### Weekly Summary
```
Week of March 24-30:

  Exercise    ███████ 7/7  (streak: 12 days)
  Meditation  ████░░░ 4/7  (streak: 2 days)
  Reading     █████░░ 5/7  (streak: 5 days)
  Water 2L    ███░░░░ 3/7  (no active streak)

Best streak: Exercise (12 days)
Needs attention: Water intake
```

## Accountability

- **Gentle nudges:** If a habit is consistently missed, mention it during relevant conversations (not every message)
- **Celebrate milestones:** 7 days, 30 days, 100 days — acknowledge these
- **No guilt:** If a streak breaks, focus on restarting, not on the failure
- **Trend over perfection:** 5/7 days is better than 0/7 — acknowledge partial success

## Guidelines

- Store all habit data in memory so it persists across conversations
- Never nag — offer encouragement, not pressure
- If the user stops mentioning a habit, don't assume it's being done — ask during check-ins
- Pair with daily-rhythm for integrated daily check-ins
- The user defines what counts as "done" — don't impose standards
