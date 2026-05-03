---
name: interest-driven-nudge
kind: heartbeat
schedule_hint: "every 4h"   # actual interval set on `flopsy heartbeat add --every 14400000`
delivery: conditional
why: Catch high-signal events on the user's interest topics during the day, without a fixed schedule. Most fires SKIP — only ~1 in 4 should produce a message.
---

You are firing on the interest-nudge heartbeat (every ~4 hours).

GOAL (one sentence):
Most fires should be SILENT. Only message the user if there's something
NEW and HIGH-SIGNAL on one of their top interests since the last fire.

The default outcome is no message. Your bias should be "skip unless
genuinely worth it." A heartbeat that fires 6× a day with 1 message a
week is healthy.

STEPS:
1. Check guards. Abort silently on any trip.
2. Read profile interests. Pick the SINGLE most-recently-added interest
   (or the one most-recently mentioned in conversation). One topic only.
3. Quick check via legolas:
   ```
   delegate_task("legolas", task=
       "Anything genuinely new on <topic> in the last 4 hours? "
       "I want a high bar: only flag if there's a fresh result, "
       "release, news event, or contradiction worth a 2-line update. "
       "Skim the top 3 sources for this topic. "
       "Return JSON: { worth_messaging: bool, headline: str, summary: str, source_domain: str } "
       "If nothing meets the bar, worth_messaging: false."
   )
   ```
4. Parse legolas's reply. If `worth_messaging: false` → silent return.
5. ONE send_message:
   ```
   ⚡ <topic>: <legolas's headline>

   <legolas's summary in ≤2 sentences>

   <source domain>
   ```

GUARDS (apply ALL):
- Quiet hours 23:00–07:00 user-local → silent return.
- DND → silent return.
- User actively chatting (last user msg < 15 min) → defer.
- Already messaged on this topic in the last 12 hours → skip.
- ANY ⚡ heartbeat message has fired in the last 4 hours → skip (rate limit
  the channel; heartbeats can run more often than they message).
- Daily budget: if the user has received 3+ proactive messages today
  (across all schedules), abort silently. The daily-news + email digests
  already saturate the morning.

DON'T:
- Don't message just because the heartbeat fired. The default is silence.
- Don't pad with "I just wanted to share…" or framing language. Headline
  + 2-sentence summary + source. Done.
- Don't repeat content the user already saw in today's digest. Cross-
  reference recent send_message history first.
- Don't fire on stale interests (>60 days old). Operator must refresh.

LOG (silent):
On each fire, write a one-line debug note to scratchpad: "[heartbeat
fire <ts>] topic=<X> worth_messaging=<bool> guard=<which>" so an
operator can see fire-vs-message ratio. Healthy ratio: ~1:5 to 1:10.
If you find yourself messaging more than 1 in 4 fires, the bar is
too low — tighten the legolas prompt next iteration.
