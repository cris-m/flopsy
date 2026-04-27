---
name: argument-mapping
compatibility: Designed for FlopsyBot agent
description: Map the logical structure of any argument — premises, conclusions, hidden assumptions, and fallacies. Use when analyzing political speeches, opinion pieces, or any persuasive content.
---

# Argument Mapping

Decompose any argument into its logical structure. Identify what's being claimed, what supports it, what's assumed without evidence, and where the reasoning breaks down.

## When to Use This Skill

- User shares a political speech, opinion piece, or persuasive content
- User asks "what's wrong with this argument?"
- Evaluating the logic of a proposal, pitch, or claim
- As part of critical-analysis-chain

## Workflow

### Step 1: Identify the Conclusion
What is the speaker/writer ultimately trying to convince you of? State it in one sentence.

### Step 2: Extract the Premises
What reasons or evidence do they give to support the conclusion?
- Explicit premises (stated directly)
- Implicit premises (assumed but not stated — often the weakest link)

### Step 3: Map the Inference
How do the premises connect to the conclusion?
```
Premise 1: [stated reason]
Premise 2: [stated reason]
Hidden Premise: [unstated assumption]
        ↓ (inference)
Conclusion: [what they claim follows]
```

### Step 4: Check for Fallacies
Does the reasoning contain logical errors?

## Common Fallacies

| Fallacy | Pattern | Example |
|---------|---------|---------|
| **Ad Hominem** | Attack the person, not the argument | "You can't trust his analysis — he failed in business" |
| **Straw Man** | Misrepresent the opposing view, then attack the misrepresentation | "They want open borders!" (when the position was immigration reform) |
| **False Dichotomy** | Present only two options when more exist | "You're either with us or against us" |
| **Appeal to Authority** | It must be true because an authority says so | "The president said it, so it must be right" |
| **Slippery Slope** | Claiming one step inevitably leads to an extreme outcome without evidence | "If we allow X, soon we'll have Y, then Z" |
| **Circular Reasoning** | The conclusion is used as a premise | "This is true because it's right, and it's right because it's true" |
| **Red Herring** | Introducing an irrelevant topic to divert attention | Answering a corruption question with "but the economy is growing" |
| **Appeal to Emotion** | Using emotion instead of logic | "Think of the children!" (with no logical connection to the argument) |
| **Bandwagon** | It must be right because many people believe it | "Everyone knows that..." |
| **False Cause** | Assuming correlation is causation | "Crime rose after the policy, so the policy caused crime" |
| **Whataboutism** | Deflecting criticism by pointing to someone else's actions | "What about when they did X?" |
| **Moving the Goalposts** | Changing the criteria for proof when the original criteria are met | "OK that's true, but what about..." |
| **Equivocation** | Using a word with two meanings as if they're the same | "The law says we have the right to bear arms" (legal right vs moral right) |

## Output Format

```markdown
## Argument Map: [Source/Speaker]

### Conclusion
[What they're trying to convince you of]

### Stated Premises
1. [Explicit reason given]
2. [Explicit reason given]

### Hidden Premises
1. [Assumption required for the argument to work, but not stated]

### Inference Chain
[How premises connect to conclusion]

### Fallacies Detected
- **[Fallacy name]:** [Where it appears and why it's fallacious]

### Assessment
- **Logical validity:** [Does the conclusion follow from the premises? Yes/No/Partially]
- **Premise truth:** [Are the premises actually true?]
- **Overall strength:** [Strong / Moderate / Weak — with reasoning]
```

## Guidelines

- Separate logical validity from truth. An argument can be logically valid but based on false premises, or logically invalid but accidentally correct
- Not every rhetorical technique is a fallacy. Emotional appeal combined with good logic is legitimate persuasion
- Map the argument charitably first (steel-man), then identify genuine fallacies
- Hidden premises are often where the real disagreement lives — surfacing them clarifies the debate
- Pair with propaganda-recognition for content that's primarily persuasive rather than logical
