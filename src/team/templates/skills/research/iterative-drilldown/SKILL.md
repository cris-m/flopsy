---
name: iterative-drilldown
category: research
description: Progressive narrowing pattern for fuzzy or open-ended requests. Pick ONE axis of ambiguity, narrow with ONE question, repeat until the request is specific enough to execute. Anti-flailing discipline.
when-to-use: "Use when a request has 2+ valid interpretations or is broader than a paragraph — narrow ONE axis per round before executing. NOT when the request is already concrete."
metadata:
  flopsy:
    agent-affinity: [gandalf, gimli, saruman, aragorn]
---

# Iterative drilldown

Open-ended questions ("tell me about X", "help with Y", "debug this") have a failure mode: you pick an interpretation that doesn't match the user's intent, then spend three rounds answering the wrong question. The fix is structural — drill down ONE axis at a time before executing.

## The loop

**1. Identify the axes of ambiguity.** Scan the request for 2–4 dimensions that could go differently. For "explain attention" the axes are: depth (basics vs research-level), framing (intuitive vs mathematical), scope (just self-attention or also multi-head), and audience (knows transformers vs starting fresh). Pick the dominant axis — the one whose answer changes the most about your response.

**2. Ask ONE narrowing question.** Phrase as binary or short multiple-choice. Good: "Is this for understanding the concept or implementing it?" Bad: "Could you tell me more about your background, goals, level…" — compound, vague, off-loads work onto the user.

**3. Listen for the next narrow.** User answers → you now know one axis. Are remaining axes still ambiguous? If yes, repeat step 2 on the NEXT dominant axis. If no, execute.

**4. Cap at 3 narrowing rounds.** After 3 questions, you either have enough specificity or the user is annoyed. Then: execute on best-current understanding and explicitly surface the assumption ("I'm answering as if you want an intuitive explanation — let me know if you wanted code") OR summarize what you've learned and let the user redirect.

## When NOT to use

- Concrete task with one obvious interpretation ("schedule 2pm meeting"). Just do it.
- User explicitly said "give me all your thoughts on X" — they want breadth.
- Only one small axis of ambiguity with an obvious default. Pick the default, mention it, proceed.
- You're stalling. If the answer comes naturally with one stated assumption, state the assumption + answer; don't drill.

## Anti-flailing rules

- **One question per round.** Multi-question rounds force the user to track context across answers.
- **Narrow, never widen.** Each round must reduce the answer surface, not introduce new dimensions.
- **No "tell me more".** Generic prompts put all the work on the user. Always have a specific axis in mind.
- **Skip what's obvious from context.** If they're clearly a developer, you don't need to ask "are you technical?".
- **State your assumption when you stop drilling.** "I'm assuming X — say so if you wanted Y" is better than silent guessing.

## Worked example — chat (gandalf)

> User: "explain attention mechanism"

Axes: depth (toy vs paper-grade), framing (intuitive vs formula), scope (self-attention only vs multi-head/cross), audience (knows transformers or new).

Dominant axis = depth.

> You: "Quick intuitive sweep, or a deeper walkthrough with the formula?"
> User: "deeper, with formula"

Remaining ambiguity: scope.

> You: "Just self-attention, or also multi-head and how it relates to cross-attention?"
> User: "all of them"

Now specific. Execute: formula-grounded walkthrough covering self, multi-head, cross.

## Worked example — research (saruman)

> User: "what's the impact of LLMs on software engineering?"

Axes: timeframe (current vs projected), angle (productivity / displacement / code quality / security), granularity (overview vs evidence-based per-vertical).

Dominant axis = angle.

> You: "Productivity, displacement, code quality, or security angle?"
> User: "code quality"

Remaining axes are smaller. Pick defaults, state them, proceed:

> You: "I'll focus on current evidence (2024–2026 papers + surveys), evidence-based with examples — proceeding."

Then execute the research loop on that scope.

## Worked example — analysis (gimli)

> User: "this function is slow, help me speed it up"

Axes: baseline (profiled or "feels slow"?), constraint (readable vs maximum speed), input shape (small N vs large N optimize differently).

Dominant axis = baseline. If they haven't measured, optimization is guesswork.

> You: "Have you profiled it, or is it 'feels slow'? If profiled, paste the hotspot."

If profiled → execute on the hotspot. If not → suggest a quick profile run, then drill once they have data.

## Worked example — security (aragorn)

> User: "investigate this IP"

Axes: scope (just reputation, or full recon?), urgency (is this actively impacting prod, or background?), depth (cheap free-source check vs paid intel triangulation).

Dominant axis = scope.

> You: "Reputation check only, or full recon with Shodan / VirusTotal / passive DNS?"
> User: "full recon"

Now narrower. Defaults for remaining: assume not-urgent unless told, depth = whatever recon-discipline calls for.

> You: "Running full recon — Shodan + VirusTotal + DNS triangulation. Back in 1–2 minutes."

Execute the recon-discipline workflow.

## Activation triggers

Apply when the request matches any:
- Less than one sentence of specificity for a topic with many valid answers
- "Tell me about", "help with", "explain", "what about", "thoughts on"
- Diagnostic / troubleshooting with no symptom specifics
- A question whose honest answer would be a 30-minute reply

Don't activate when:
- The request is one specific action ("send a message saying X")
- User signalled they want breadth ("give me a quick overview", "I just want to skim")
- You'd ask the same narrowing question whether they answered narrowly or broadly — that means your axis isn't actually load-bearing
