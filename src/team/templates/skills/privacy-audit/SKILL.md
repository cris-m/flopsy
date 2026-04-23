---
name: privacy-audit
compatibility: Designed for FlopsyBot agent
description: Audit digital footprint, check for data exposure, and recommend remediation. Use when the user asks "am I exposed?", "is my data safe?", or wants a privacy check.
---

# Privacy Audit

Assess the user's digital exposure and provide actionable remediation steps.

## When to Use This Skill

- User asks "am I exposed online?", "audit my privacy"
- User wants to check for data breaches
- User is concerned about a specific exposure (leaked email, phone number)
- Proactive privacy check during security discussions

## Audit Process

### Step 1: Scope
Ask what to check:
- Email addresses
- Phone numbers
- Full name + location
- Usernames across platforms
- Domain ownership

### Step 2: Data Breach Check
For each email/username:
- Search Have I Been Pwned patterns: `web_search "[email] data breach"`
- Check known breach databases
- Note which breaches included passwords vs just email

### Step 3: Public Information Exposure
Search for the user's information in public sources:
- Search engines (name + city, email, phone)
- Social media profiles (public visibility settings)
- Data broker sites (Spokeo, WhitePages, BeenVerified patterns)
- Domain WHOIS records
- Court records, property records (if relevant)

### Step 4: Assess Severity

| Exposure | Severity | Action |
|----------|----------|--------|
| Email in breach (no password) | Low | Monitor, no immediate action |
| Email + password in breach | High | Change password immediately, check reuse |
| Phone number public | Medium | Monitor for SIM swap, remove from data brokers |
| Home address public | Medium-High | Request removal from data brokers |
| Financial data exposed | Critical | Credit freeze, fraud alerts |
| Password reuse detected | High | Change all reused passwords |

### Step 5: Remediation

Provide specific, actionable steps — not just "be careful."

## Output Format

```markdown
## Privacy Audit Results

### Breach Exposure
- **[Email/Account]:** Found in [X] breaches
  - [Breach 1] ([date]): [data exposed]
  - [Breach 2] ([date]): [data exposed]
- **Action:** [Specific steps]

### Public Information
- **Search engines:** [What's findable]
- **Social media:** [What's public that shouldn't be]
- **Data brokers:** [Where info appears]
- **Action:** [Specific removal steps]

### Password Health
- **Reused passwords:** [Yes/No/Unknown]
- **Action:** [Use password manager, change reused passwords]

### Recommendations (Priority Order)
1. [Most urgent action]
2. [Second priority]
3. [Third priority]

### Ongoing Protection
- [Monitoring recommendations]
```

## Guidelines

- Be specific: "Change your Twitter password" not "Update your passwords"
- Provide actual links to removal/opt-out pages when possible
- Never store the user's passwords or sensitive credentials
- Note limitations: "I can check public sources but not dark web databases"
- Pair with phishing-detection for ongoing protection awareness
- Respect the user's privacy comfort level — some people accept more exposure than others
