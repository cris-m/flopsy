---
name: financial-tracker
compatibility: Designed for FlopsyBot agent
description: Track expenses, income, and budgets using memory. Use when the user logs spending, asks about budgets, or wants financial summaries.
---

# Financial Tracker

Track income and expenses, categorize spending, and provide budget summaries. All data stored in memory.

## When to Use This Skill

- User says "I spent $X on Y", "log an expense", "add income"
- User asks "how much did I spend this month?", "what's my budget status?"
- Monthly or weekly financial summaries
- User wants to set or check a budget

## Expense Logging

When the user mentions a purchase or expense:
1. Extract: amount, category, description, date (default: today)
2. Confirm if ambiguous
3. Save to memory: `finance:expense:[date] = { amount, category, description }`
4. Acknowledge with running total for the category

### Categories
Use these defaults (user can customize):
- Food & Dining
- Transport
- Housing (rent, utilities)
- Entertainment
- Shopping
- Health
- Education
- Subscriptions
- Savings / Investment
- Other

## Output Formats

### Quick Log Acknowledgment
```
Logged: $45 — Food & Dining (lunch)
March total for Food: $320 / $500 budget (64%)
```

### Monthly Summary
```
March 2026 Summary:

  Food & Dining     $320 / $500   ████████░░  64%
  Transport         $150 / $200   ███████░░░  75%
  Entertainment      $80 / $150   █████░░░░░  53%
  Subscriptions     $55  / $60    █████████░  92%
  Shopping          $200 / $300   ██████░░░░  67%

  Total Spent:      $805
  Total Budget:     $1,210
  Remaining:        $405

  Income:           $3,500
  Savings Rate:     23%
```

### Trend Alert
```
Heads up: Food spending is 40% higher than last month at this point.
Last month total: $480 | This month pace: $670 projected
```

## Budget Management

- **Setting budgets:** "Set my food budget to $500/month"
- **Alerts:** Warn when a category reaches 80% of budget
- **Rollover:** Unspent budget does NOT roll over by default (user can change this)
- **No-budget categories:** Track spending even without a budget — the data itself is useful

## Guidelines

- Store all financial data in memory, organized by month
- Never judge spending — present data, not opinions
- Round to the user's currency (detect from context or ask once)
- If an expense is ambiguous ("$20 at Target"), ask for category or make a reasonable assumption and note it
- Protect financial data — never share summaries in group chats or with other users
- Pair with daily-rhythm for integrated financial check-ins
