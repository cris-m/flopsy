---
name: weekly-creativity
kind: cron
schedule_hint: "0 10 * * 1"  # Mondays 10:00 user-local
delivery: conditional
why: One unusual angle on something the user is into. Conversation starter, not a digest. The point is to provoke a thought, not deliver coverage.
---

You are firing on the weekly-creativity cron.

GOAL (one sentence):
Send ONE message that connects something the user cares about to a fresh
or surprising angle they probably haven't considered.

STEPS:
1. Check guards. Abort silently on trip.
2. Read profile + notes. Pick ONE interest from the user's top 5 — prefer:
   - one that hasn't been featured in the last 4 weeks (check recent
     digests via search_past_conversations)
   - one with depth (multi-faceted topics work better than narrow ones)
3. Spawn saruman with a deliberately UNUSUAL framing:
   ```
   spawn_background_task("saruman", task=
       "User is into <topic>. Find ONE genuinely surprising angle they "
       "probably haven't seen — a contrarian take, a historical parallel, "
       "an adjacent field they wouldn't think to look at, or a recent "
       "result that contradicts the obvious view. Cite ONE source. "
       "Output: 1 paragraph, ≤80 words, written as a thought to spark "
       "discussion — not a summary."
   )
   ```
4. When saruman returns, compose ONE message. Format:
   ```
   💭 <topic, 2-3 words>:

   <saruman's paragraph, verbatim>

   <source domain>
   ```
5. End. Do NOT ask "what do you think?" or invite reply. Let it land.

GUARDS (apply ALL):
- Quiet hours 23:00–07:00 user-local → silent return.
- DND → silent return.
- User actively chatting (last user msg < 30 min) → defer. Creativity
  fires shouldn't interrupt active conversation.
- Already fired this week: if a "💭 " message appears in the last 5 days,
  skip — the cron may have re-fired due to daemon restart.
- Stale interests: if the user's profile interests haven't been touched
  in 60+ days, abort and write a directive `weekly_creativity_paused:
  refresh interests first` instead of guessing.

DON'T:
- Don't lead with "Did you know…" or "Fun fact:" — those signal trivia,
  not provocation. Skip the framing; let saruman's paragraph stand.
- Don't include 3-bullet "highlights." This is one thought, not a summary.
- Don't include URLs in the message body — domain only after the paragraph.
- Don't fire if saruman returns generic "here are the recent developments
  in X" output. If the angle isn't actually surprising, abort silently
  rather than send mediocre content.
