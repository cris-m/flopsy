---
name: daily-news-digest
kind: cron
schedule_hint: "0 8 * * *"  # 08:00 user-local; schedule lives in the daemon
delivery: always
why: One short morning briefing on whatever the user is currently into. The point is signal, not coverage.
---

You are firing on the morning news cron.

GOAL (one sentence):
Send the user ONE short message with up to 3 headlines on their stated
interest topics, biased toward NEW developments since yesterday.

STEPS:
1. Check guards (see GUARDS below). If any trip, return without messaging.
2. Read the user's profile + notes. Extract their top 3 stated interest
   topics. If fewer than 2 interests on file, send a one-line nudge instead:
   "I'd love to send you a daily brief but I don't know what you're into yet
   — tell me 2-3 topics?" and return.
3. Use execute_code with use_tools=true to fan out:
   ```
   results = parallel_map(
       "saruman",
       [f"What's NEW today on: {topic}? 2 bullets, prefer last-24h sources, cite domain only" for topic in top_3_interests]
   )
   ```
4. Compose the message. ONE send_message. Format:
   ```
   ☀️ Today (<DATE>):
   • <topic 1>: <one-line headline> (<source domain>)
   • <topic 2>: <one-line headline> (<source domain>)
   • <topic 3>: <one-line headline> (<source domain>)

   Reply "more on X" for the briefing.
   ```

GUARDS (apply ALL — abort silently on any trip):
- Quiet hours: between 23:00 and 07:00 user-local → silent return.
  Call `time` to check. The cron is set to 08:00 but DST or thread-zone
  drift could fire it inside quiet hours.
- DND active → silent return.
- Already sent today: read the last 30 messages in this thread. If a
  message starting with "☀️ Today" was sent within the last 18 hours,
  skip — don't double-send.
- User actively chatting: if the last USER message was within 10 minutes,
  defer (return without messaging). The user is doing something; don't
  interrupt with a digest.

DON'T:
- Don't send if interests are empty or stale (>30 days unchanged) — nudge
  the user to refresh interests instead.
- Don't include headers, table-of-contents, or "Good morning! I noticed…".
- Don't include more than 3 bullets, even if you found more.
- Don't include URLs in the bullets — just the source domain in parens.
- Don't repeat content from yesterday's digest. If saruman returns
  near-identical headlines to what you sent yesterday, swap them out for
  the next-best result or skip that topic.

LOG (silent — for operator only):
If you abort due to a guard, write one line to your scratchpad explaining
which guard tripped. Helps operator tune cron timing.
