---
name: osint
compatibility: Designed for FlopsyBot agent
description: Open-source intelligence gathering and investigation methodology. Use when investigating a person, company, domain, or verifying claims using publicly available information.
---

# OSINT (Open-Source Intelligence)

Systematic methodology for gathering and analyzing publicly available information to investigate entities, verify claims, or assess threats.

## When to Use This Skill

- User says "what can you find about [person/company/domain]?"
- Investigating a suspicious entity, website, or offer
- Verifying someone's identity or credentials
- Gathering background information before a meeting or deal
- Assessing a company's legitimacy

## When NOT to Use

- The user is asking for private/non-public information (this skill only uses public sources)
- Stalking, harassment, or targeting individuals — refuse and explain why

## Ethical Boundaries

- **Only public information** — never attempt to access private accounts, databases, or systems
- **Respect privacy** — if someone has deliberately removed information, note the gap but do not try to circumvent it
- **Proportional depth** — a company background check warrants deeper investigation than a casual "who is this person?" question
- **Report limitations** — always state what you could NOT verify

---

## Investigation Process

### Step 1: Define Scope

Before investigating, clarify:
- **Target**: Who or what is being investigated?
- **Purpose**: Why? (background check, scam verification, due diligence)
- **Depth**: Quick check or deep dive?

### Step 2: Passive Reconnaissance

Gather information without directly interacting with the target:

| Source | What to Check | Tools |
|--------|--------------|-------|
| **Web presence** | Website, about page, team page, history | web_search, web_extract |
| **Social media** | Profiles, post history, connections, consistency | web_search |
| **Domain info** | Registration date, registrant, hosting, DNS | web_search (WHOIS lookups) |
| **Business records** | Registration, filings, officers, address | web_search (company registries) |
| **News & press** | Coverage, mentions, lawsuits, controversies | web_search |
| **Technical footprint** | Open ports, services, vulnerabilities | Shodan (if available) |
| **Reputation** | Reviews, complaints, scam reports | web_search (site:trustpilot.com, BBB, etc.) |
| **Web archive** | Historical versions of websites | web_search (site:web.archive.org) |
| **Security** | Breaches, malware associations | VirusTotal (if available) |

### Step 3: Cross-Reference

- Do claims on the website match public records?
- Does the timeline make sense? (company claims 10 years experience but domain registered 6 months ago)
- Do the people listed actually exist and have verifiable backgrounds?
- Are there inconsistencies between different sources?

### Step 4: Assess and Report

For each finding, assign a confidence level:

| Level | Meaning |
|-------|---------|
| **Verified** | Confirmed across 2+ independent sources |
| **Probable** | Single credible source, consistent with other findings |
| **Unverified** | Found but cannot confirm independently |
| **Suspicious** | Contradicts other evidence or contains red flags |

## Output Format

```
## OSINT Report: [Target Name]

### Summary
[1-2 sentence assessment]

### Findings

#### Web Presence
- [Finding] (Confidence: Verified/Probable/Unverified)
- Source: [URL]

#### Business Records
- [Finding] (Confidence: ...)
- Source: [URL]

#### Social Media
- [Finding] (Confidence: ...)

#### Red Flags
- [Any concerning findings]

#### Could Not Verify
- [What remains unknown]

### Assessment
[Overall credibility assessment with reasoning]
```

## Red Flag Indicators

| Indicator | What It Suggests |
|-----------|-----------------|
| Domain registered very recently | May be a fly-by-night operation |
| No verifiable team members | Possible shell/fake company |
| Address is a virtual office or PO box | Not necessarily bad, but note it |
| Inconsistent claims across sources | Credibility issue |
| Removed/hidden WHOIS info | Common for privacy, but note it |
| No press coverage despite big claims | Claims may be exaggerated |
| Fake reviews or testimonials | Deceptive practices |
| Copy-pasted content from other sites | Low-effort or scam operation |

## Guidelines

- Start broad, then narrow based on what you find
- Prioritize verifiable facts over inferences
- Note the absence of information — sometimes what's missing is more telling than what's present
- Time-bound your investigation — state the date of your search, as information changes
- Combine with source-assessment skill when evaluating individual sources
- If the investigation reveals potential criminal activity, advise the user to contact appropriate authorities rather than investigating further
