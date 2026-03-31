---
name: financial-literacy
compatibility: Designed for FlopsyBot agent
description: Evaluate financial claims, deals, investment pitches, and contracts. Detect Ponzi indicators, unrealistic returns, and hidden fees. Use when the user asks "is this legit?" about a financial opportunity.
---

# Financial Literacy

Evaluate financial claims with the same rigor applied to political analysis. Follow the money, check the math, and identify what's hidden.

## When to Use This Skill

- User asks "is this investment legit?", "should I invest in...?"
- User shares a crypto project, business opportunity, or financial product
- Evaluating a trade agreement or economic deal
- User asks about a contract, loan, or financial product terms

## Red Flag Detection

### Ponzi / Scam Indicators
| Indicator | Why It's a Red Flag |
|-----------|-------------------|
| Guaranteed high returns | No legitimate investment guarantees returns |
| "Risk-free" | All investments carry risk — claiming otherwise is a lie |
| Pressure to recruit others | Revenue from recruitment, not product = pyramid |
| Complex or opaque structure | If you can't explain how money is made, that's by design |
| Unregistered / unlicensed | Legitimate funds are registered with regulators |
| Withdrawal restrictions | Easy to put money in, hard to get it out |
| Returns paid from new deposits | The definition of a Ponzi scheme |
| Celebrity endorsements | Paid promotion, not investment advice |

### Crypto-Specific Red Flags
| Indicator | Concern |
|-----------|---------|
| Anonymous team | No accountability |
| No working product | Vaporware |
| Tokenomics that benefit insiders | Large team/advisor allocations, short vesting |
| Unrealistic APY (>100%) | Unsustainable — funded by new deposits or token inflation |
| "Decentralized" but admin keys exist | False decentralization |
| Forked code with no innovation | Cash grab, not a project |

## Evaluation Framework

### For Investment Opportunities
1. **Who is behind it?** (Track record, registration, verifiable identity)
2. **How does it make money?** (Revenue model — if unclear, walk away)
3. **What are the risks?** (If none are mentioned, they're being hidden)
4. **What's the track record?** (Audited returns, not screenshots)
5. **What are the fees?** (Hidden fees destroy returns)
6. **What happens if you want out?** (Liquidity, lock-ups, penalties)
7. **Is it regulated?** (SEC, FCA, etc. — check the register)

### For Contracts & Deals
1. **What do both sides give and get?** (Is it proportional?)
2. **What's in the fine print?** (Termination clauses, penalties, auto-renewal)
3. **Who bears the risk?** (Often asymmetric)
4. **What's not in the contract?** (Verbal promises that aren't written down)
5. **What happens when things go wrong?** (Dispute resolution, liability)

## Output Format

```markdown
## Financial Assessment: [Product/Deal/Opportunity]

### Summary
[1-2 sentence verdict]

### Red Flags
- [Flag 1]: [Specific evidence]
- [Flag 2]: [Specific evidence]
- (or "No red flags detected")

### Revenue Model
[How does this actually make money?]

### Risk Assessment
- **Stated risks:** [What they tell you]
- **Hidden risks:** [What they don't]

### Fee Structure
[All fees, including hidden ones]

### Comparable Alternatives
[What else exists in this space? How does this compare?]

### Verdict
[Legitimate / Proceed with caution / Avoid]
**Confidence:** [High / Medium / Low]
```

## Guidelines

- "If it sounds too good to be true, it is" — this maxim has a near-perfect track record
- Never evaluate an investment in isolation — always compare to alternatives (opportunity cost)
- Past returns do not guarantee future returns, but past fraud does predict future fraud
- The complexity of a financial product is often inversely proportional to its value to the customer
- Pair with osint skill to verify the people and companies behind financial products
