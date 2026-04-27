---
name: propaganda-recognition
compatibility: Designed for FlopsyBot agent
description: Recognize propaganda techniques in media and information. Use when fact-checking news, analyzing articles for bias, or identifying manipulative rhetoric.
---

# Propaganda Recognition Skill

This skill provides insight into recognizing propaganda in media and information. It focuses on identifying key patterns, strategies, and psychological tactics that might indicate biased or manipulative content.

## When to Use This Skill

- Fact-checking news stories that may have biased perspectives.
- Analyzing articles and publications for propaganda techniques.
- Educating users on spotting propaganda in media.

## Key Patterns in Propaganda

1. **Emotionally Charged Language**:
   - Usage of words or phrases designed to evoke strong emotions such as fear, anger, or sympathy.
   - Examples include sensationalism, extreme imagery, and polarizing language.

2. **Over-simplification**:
   - Creating a simplistic cause-and-effect relationship or binary perspective that overlooks complexity.
   - Examples include phrases like "all experts agree" or "the only solution."

3. **Targeting Enemies**:
   - Presenting an "us vs. them" narrative that identifies a common enemy to unite audiences.
   - Often used in political contexts or to assign blame.

4. **Repetition**:
   - Repeating certain messages or themes to enhance memorability and acceptance.
   - Propaganda often involves slogans or catchphrases.

5. **Bandwagon Effect**:
   - Suggesting that one should follow the crowd or majority opinion to create pressure for conformity.
   - Phrases like "everyone knows" or "your neighbors are doing it."

6. **Misrepresentation of Facts**:
   - Twisting facts or selectively presenting data to support a biased viewpoint.
   - This includes cherry-picking data or using misleading statistics.

## Psychological Tactics

- **Fear Mongering**: Amplifying or fabricating threats to create dependency on a solution or authority.
- **Appeals to Authority**: Assertion that something must be true because an authority supports it, regardless of evidence.
- **Scapegoating**: Blaming a person, group, or situation unfairly for broader problems.

## Workflow

1. **Cross-Verify Information**: Ensure diverse sources are consulted to compare different perspectives.
2. **Language Analysis**: Scrutinize language for emotional manipulation.
3. **Contextual Background**: Assess the broader context to uncover bias or manipulation.
4. **Fact-Checking Tools**: Utilize dedicated agents to validate facts and figures.
5. **Consider Diverse Perspectives**: Incorporate alternative viewpoints and understand their framing.

## Output Format

When analyzing content, emit a report using this template. Keep it scannable — only include sections with real findings.

```markdown
## Propaganda Analysis: [Source / Title]

**Source:** [URL or citation]
**Date analyzed:** [YYYY-MM-DD]
**Overall confidence this content uses propaganda:** [Low / Medium / High]

### Detected Patterns

| Technique | Confidence | Example Quote |
|-----------|-----------|---------------|
| Emotionally Charged Language | High | "A tidal wave of destruction threatens our way of life." |
| Us-vs-Them Framing | Medium | "They will never understand what we stand for." |
| Bandwagon Appeal | Low | "Everyone is waking up to the truth." |

### Psychological Tactics

- **Fear Mongering:** [Brief explanation + short quote]
- **Appeals to Authority:** [Brief explanation + short quote]
- **Scapegoating:** [Brief explanation + short quote]

### What's Missing

- Contradicting evidence, dissenting expert views, or context the piece omits
- Inconvenient facts that weaken its core claim

### Recommendations

- Cross-check specific claim X against [independent source]
- Note emotional framing when sharing or citing this piece
- Seek the steel-man version of the opposing view before forming a position

### Caveats

- Propaganda detection is probabilistic, not deterministic
- A pattern match does not automatically mean the claim is false — evaluate evidence separately
```

## Confidence Rubric

Use these thresholds when assigning per-technique confidence:

| Level | Criteria |
|-------|----------|
| **High** | Multiple clear textual examples; the technique is central to the piece's persuasion |
| **Medium** | At least one clear example; technique supports but doesn't define the piece |
| **Low** | Faint or arguable match; could also be ordinary rhetoric |

For the overall confidence that a piece uses propaganda, require at least two Medium-or-above techniques before assigning High.

By implementing this skill, users are equipped to discern and navigate misleading information and propaganda effectively.
