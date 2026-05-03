---
name: email-summary
kind: cron
schedule_hint: "0 8,18 * * *"  # 08:00 + 18:00 user-local
delivery: conditional
why: Surface the few emails that actually matter (LinkedIn DMs, hiring messages, contracts) without the user having to open Gmail.
---

You are firing on the email-summary cron.

GOAL (one sentence):
Send a short summary of the user's IMPORTANT unread emails since the last
fire — only if there's at least one worth reading.

STEPS:
1. Check guards. Abort silently on trip.
2. Delegate to legolas with a tight scope:
   ```
   delegate_task("legolas", task=
       "Read my Gmail. Return JSON: list of unread emails from the last 12h "
       "matching ANY of these labels/categories: hiring, recruiter, LinkedIn, "
       "important, contract. Skip newsletters, marketing, and notifications. "
       "For each: { sender_short_name, subject, one_line_summary, gmail_id }. "
       "Return at most 5. If none, return []."
   )
   ```
3. Parse legolas's reply. If empty array → silent return (don't send a
   "no new emails" message; that's noise).
4. Compose ONE message. Format:
   ```
   📬 Inbox (<N> worth reading):
   • <Sender> — <subject>: <one-line summary>
   • ...

   Reply "open <N>" to draft a response or "skip" to dismiss.
   ```
5. Mark these emails as "surfaced" via manage_note (key:
   `email_surfaced:<gmail_id>`, value: timestamp) so the next fire doesn't
   re-surface them even if still unread.

GUARDS (apply ALL):
- Quiet hours 23:00–07:00 user-local → silent return.
- DND → silent return.
- Last fire: if you ran this prompt successfully in the last 4 hours, the
  Gmail check is allowed but the SEND threshold tightens — only message if
  legolas returns 2+ emails (avoid stacking small notifications).
- Already-surfaced: drop any email whose `gmail_id` matches an existing
  `email_surfaced:*` note. Update notes after sending so today's set is
  recorded.
- User actively chatting (last user msg < 10 min) → defer.

DON'T:
- Don't read or quote email bodies in the message — one-line summary only.
- Don't claim importance the user didn't ask for ("URGENT!" / "🔥") unless
  the email actually says it. Stick to neutral phrasing.
- Don't include the gmail_id in the user-visible message — keep it in
  notes so you can refer back without leaking IDs.
- Don't fire a second message in the same turn even if you find an email
  the user might want to reply to immediately. Wait for them to ask.

If legolas's tools aren't available (Gmail not connected): write a single
note to a scratch directive `email_summary_blocked: gmail not connected`
and return silently. Don't message the user about it — the operator will
notice via /mcp.
