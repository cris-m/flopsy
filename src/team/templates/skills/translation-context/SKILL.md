---
name: translation-context
compatibility: Designed for FlopsyBot agent
description: Translation with cultural context, connotation, and subtext — not just word-for-word conversion. Use when the user shares text in another language and wants to understand what it really means.
---

# Translation with Context

Go beyond word-for-word translation — explain what the text really means, including cultural connotation, register, idioms, and subtext that a literal translation would miss.

## When to Use This Skill

- User shares text in another language and asks "what does this mean?"
- User asks "what does this really mean in [language]?"
- User wants to understand the tone or subtext of a message
- User needs to communicate something in another language with the right tone
- User encounters an idiom or expression that doesn't translate directly

## Workflow

### Step 1: Literal Translation
Provide a direct translation — word for word where possible.

### Step 2: Natural Translation
Rephrase into natural, idiomatic English (or target language) that captures the actual meaning.

### Step 3: Cultural Context
Explain what the text really means in context:
- What's the connotation? (positive, negative, neutral — beyond the dictionary definition)
- What cultural knowledge is assumed?
- Is there subtext or implication?
- Would the tone be interpreted differently in another culture?

### Step 4: Register & Formality Analysis
- Is this formal, informal, or slang?
- What does the register choice tell you about the relationship between speaker and audience?
- Would using this register in a different context be inappropriate?

### Step 5: Flag Potential Misunderstandings
- Idioms that don't have a direct equivalent
- False friends (words that look similar but mean different things)
- Cultural references that require context
- Tone that might be misread by a non-native speaker

## Output Format

```markdown
## Translation

**Original:** [text in original language]
**Language:** [detected language]

### Literal Translation
[Word-for-word translation]

### Natural Translation
[What it actually means in natural English]

### Cultural Context
[Explanation of connotation, subtext, cultural assumptions]

### Register
[Formal / Informal / Slang / Literary / Official] — [what this implies about context]

### Potential Misunderstandings
- [Anything a non-native speaker might misread]
```

## Reverse Translation (composing in another language)

When the user wants to say something in another language:

1. Understand the intent and desired tone
2. Compose in the target language
3. Provide a back-translation so the user can verify meaning
4. Note any cultural pitfalls — what might be appropriate in English but offensive or odd in the target language
5. Offer formal and informal variants if relevant

## Guidelines

- Always identify the source language, even if the user didn't specify
- If the text contains multiple languages (code-switching), note this — it's often culturally significant
- For political or sensitive content, explain how the language choice shapes perception (propaganda often uses specific linguistic techniques that vary by language)
- Slang and internet language evolve fast — note if a translation might be outdated
- Regional variations matter — French in Paris, Kinshasa, and Montreal carry different connotations
- If you're uncertain about a translation, say so — a wrong translation is worse than an admitted gap
- Pair with source-assessment when translating news or political content — translation choices can introduce bias
