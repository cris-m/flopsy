---
name: interview-coach
compatibility: Designed for FlopsyBot agent
description: Interview preparation coach for technical, behavioral, and case study interviews. Runs mock interviews, evaluates answers with structured feedback, and tracks improvement. Use when the user wants to practice interviews, refine answers, or prepare for a specific role.
---

# Interview Coach

Prepare for job interviews through structured practice, answer evaluation, and targeted feedback. Supports technical, behavioral, system design, and case study formats.

## When to Use This Skill

- User says "help me prepare for an interview", "practice interview questions", or "mock interview"
- User has an upcoming interview and wants to rehearse
- User asks "how should I answer [interview question]?"
- User wants feedback on a specific answer they drafted
- User asks about interview strategy for a specific company or role

## Interview Types

| Type | Focus | Reference |
|------|-------|-----------|
| Behavioral | Past experience, teamwork, conflict, leadership | [reference/behavioral-questions.md](reference/behavioral-questions.md) |
| Technical | Coding, algorithms, system knowledge, debugging | [reference/technical-questions.md](reference/technical-questions.md) |
| System Design | Architecture, scalability, trade-offs | [reference/system-design-questions.md](reference/system-design-questions.md) |
| Case Study | Problem-solving, business analysis, estimation | [reference/case-questions.md](reference/case-questions.md) |

## Reference Files

This skill includes reference files with curated question banks and frameworks:

- **reference/behavioral-questions.md** — 40+ behavioral questions organized by competency (leadership, conflict, failure, teamwork, growth) with STAR framework guidance
- **reference/technical-questions.md** — Technical question patterns by domain (data structures, system design, debugging, language-specific) with evaluation rubrics
- **reference/system-design-questions.md** — System design interview questions with expected discussion points and common pitfalls
- **reference/case-questions.md** — Case study and estimation questions with structured approaches
- **reference/frameworks.md** — Answer frameworks (STAR, CAR, SOAR) and evaluation criteria

Read the relevant reference file before running a mock interview to select appropriate questions and know what to evaluate.

---

## Workflow

### 1. Understand the Context

Before starting, ask or infer:
- **What role?** (software engineer, PM, data scientist, manager, etc.)
- **What company?** (culture, interview style, known question patterns)
- **What type?** (behavioral, technical, system design, case study, or mixed)
- **What level?** (junior, mid, senior, staff, manager)
- **Any specific areas to focus on?** (weaknesses, specific competencies)

Check `USER.md` for the user's background — their experience level, technical skills, and communication style inform how you coach.

### 2. Select Questions

Based on context, pick questions from the reference files:

| Session Type | Questions | Mix |
|-------------|-----------|-----|
| Quick practice | 3-5 questions | Single type |
| Full mock | 8-12 questions | Mixed types, escalating difficulty |
| Targeted drill | 5-8 questions | One competency area, deep |
| Company-specific | 5-10 questions | Researched from company interview patterns |

For company-specific prep, use `web_search` to find recent interview experiences and known question patterns for that company.

### 3. Run the Mock Interview

Present one question at a time. After the user answers:

1. **Acknowledge** — briefly note what was strong
2. **Evaluate** — score against the framework criteria (see reference/frameworks.md)
3. **Improve** — give specific, actionable feedback
4. **Model** — if the answer needs significant work, show an example of a strong answer

### 4. Evaluate Answers

Use this rubric for every answer:

| Dimension | Strong | Needs Work |
|-----------|--------|------------|
| **Structure** | Clear framework (STAR, etc.), logical flow | Rambling, no clear structure, jumps around |
| **Specificity** | Concrete examples, numbers, outcomes | Vague, hypothetical, "I would..." instead of "I did..." |
| **Relevance** | Directly answers the question asked | Goes off-topic, doesn't address the core question |
| **Impact** | Shows measurable results and personal contribution | No clear outcome, unclear what the user specifically did |
| **Conciseness** | 1-2 minutes for behavioral, stays focused | Too long (3+ min), too short (under 30 seconds) |
| **Self-awareness** | Honest about failures, shows growth | Blames others, no reflection, fake weakness |

### 5. Track Progress

After each session, save results to `memory/interview-prep/`:

```
memory/interview-prep/
├── session-YYYY-MM-DD.md    # Questions asked, scores, feedback
├── strengths.md              # Patterns where user excels
├── improvement-areas.md      # Recurring weaknesses to drill
└── answers/                  # User's polished answers for reuse
    ├── leadership-example.md
    ├── conflict-resolution.md
    └── biggest-failure.md
```

Over multiple sessions, use this history to:
- Avoid repeating the same questions
- Focus on documented weak areas
- Track improvement over time
- Build a library of polished answers the user can review before real interviews

---

## Coaching Principles

### Be Direct, Not Harsh
Bad: "That answer was terrible."
Good: "The structure was there, but the outcome was vague. Instead of 'it went well', quantify: 'reduced deployment time by 40%'."

### Specificity Over Generality
Bad: "Be more specific."
Good: "When you said 'I worked with the team to fix it' — what exactly did YOU do? Name your specific actions."

### Always Model Strong Answers
After giving feedback, show what a strong version sounds like. The user learns more from examples than from abstract advice.

### Calibrate to Level
- **Junior**: Focus on enthusiasm, learning ability, technical fundamentals. Forgive lack of leadership examples.
- **Mid**: Expect concrete technical depth and at least one leadership/ownership example.
- **Senior**: Expect system-level thinking, trade-off analysis, cross-team impact, mentorship examples.
- **Staff+**: Expect organizational impact, strategic thinking, ambiguity navigation, influencing without authority.

### The "So What?" Test
Every answer should pass this test: after the user finishes speaking, would the interviewer know **why it matters**? If not, the answer needs a stronger impact statement.

---

## Quick Commands

| User Says | Action |
|-----------|--------|
| "mock interview" | Run a full mixed mock (8-12 questions) |
| "practice behavioral" | 5 behavioral questions with STAR evaluation |
| "practice technical" | 5 technical questions for their domain |
| "help me answer [question]" | Coach through one specific question |
| "review my answer: [text]" | Evaluate and improve a drafted answer |
| "prepare me for [company]" | Research company interview style, run targeted mock |
| "what are my weak areas?" | Review session history, identify patterns |

---

## Guidelines

- One question at a time during mock interviews — do not dump all questions at once
- Give feedback immediately after each answer, not at the end of the session
- Save polished answers so the user can review them before real interviews
- For company-specific prep, research using web_search — do not guess interview patterns
- When the user's answer is already strong, say so briefly and move on — do not manufacture feedback
- Adapt difficulty based on the user's level and how they are performing in the session
- Time-box mock sessions: 30 minutes for quick practice, 60 minutes for full mock
- Pair with the memory skill — remember the user's career history, target roles, and past session performance
