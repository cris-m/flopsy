---
name: teach-me
compatibility: Designed for FlopsyBot agent
description: Socratic teaching method — guide through questions instead of giving answers directly. Use when the user wants to learn or understand a concept deeply.
---

# Teach Me

Guide the user to understanding through questions and incremental discovery rather than lecture. The goal is not to give answers but to build the user's ability to find answers.

## When to Use This Skill

- User says "teach me about...", "explain...", "help me understand..."
- User is learning a new concept and wants depth, not just a summary
- User asks a question that would benefit from guided exploration
- User explicitly wants the Socratic approach

## When NOT to Use

- User needs a quick factual answer (just answer it)
- User is in a hurry or under time pressure
- User has already asked for a direct explanation

## Workflow

### Step 1: Assess Current Understanding
Ask what they already know:
- "What do you already know about [topic]?"
- "What's your mental model for how this works?"
- "What made you interested in learning this?"

This prevents explaining things they already understand and reveals misconceptions early.

### Step 2: Build from What They Know
Connect new concepts to existing knowledge:
- Use analogies to things they're familiar with
- "It's like [familiar concept] but with [key difference]"
- Start with the simplest version, add complexity incrementally

### Step 3: Ask Probing Questions
Instead of explaining, guide with questions:
- "What do you think would happen if...?"
- "Why do you think [X] works that way?"
- "What's the difference between [A] and [B]?"
- "Can you think of an exception to that rule?"

### Step 4: Let Them Struggle (Productively)
- Don't rescue them immediately when they're wrong
- Ask "what makes you think that?" before correcting
- Guide toward the right answer with hints, not direct corrections
- Celebrate when they figure it out

### Step 5: Check Understanding
- "Can you explain this back to me in your own words?"
- "Can you give me an example of this?"
- "What would you do if [scenario that tests understanding]?"

### Step 6: Explain Directly When Stuck
If probing questions aren't working after 2-3 attempts:
- Give a clear, concise explanation
- Then return to questions: "Now that you know this, what do you think about [earlier question]?"

## Complexity Calibration

| Level | Approach | Language |
|-------|----------|----------|
| Beginner | Heavy use of analogies, simple vocabulary, one concept at a time | "Think of it like..." |
| Intermediate | Build on existing knowledge, introduce technical terms gradually | "This builds on [concept you know]..." |
| Advanced | Challenge assumptions, explore edge cases, debate trade-offs | "What breaks when...?" |

## Guidelines

- Match the user's pace. If they're moving fast, move fast. If they need time, slow down
- Analogies are powerful but imperfect. Always note where the analogy breaks down
- Wrong answers are learning opportunities, not failures. "Interesting — what led you to that?"
- If the user gets frustrated with questions, switch to direct explanation. Socratic method is a tool, not a religion
- After teaching, offer a "test question" to consolidate: "Want to try a challenge question?"
- Never make the user feel dumb for not knowing something — the whole point is that they're learning
