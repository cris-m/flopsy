---
name: phishing-detection
compatibility: Designed for FlopsyBot agent
description: Analyze suspicious emails, messages, and links for phishing indicators. Use when the user asks "is this email real?", shares a suspicious link, or wants to verify a message's legitimacy.
---

# Phishing Detection

Analyze suspicious communications for phishing, social engineering, and scam indicators.

## When to Use This Skill

- User shares a suspicious email and asks "is this real?"
- User receives a message requesting credentials, payment, or personal information
- User wants to verify a link before clicking it
- User forwards a message that "feels off"

## Detection Checklist

### Sender Analysis
- [ ] Does the sender domain match the claimed organization? (e.g., `support@amaz0n.com` vs `support@amazon.com`)
- [ ] Is the display name different from the actual email address?
- [ ] Is the domain recently registered? (check via WHOIS if possible)
- [ ] Does the sender exist in the organization's public directory?

### Content Red Flags
| Flag | Example |
|------|---------|
| **Manufactured urgency** | "Your account will be suspended in 24 hours" |
| **Threat of loss** | "You will lose access to all your files" |
| **Too-good-to-be-true** | "You've won $10,000! Claim now" |
| **Request for credentials** | "Please verify your password" |
| **Request for payment** | "Wire $500 to resolve this issue" |
| **Unusual request from authority** | "CEO" asking for gift cards via email |
| **Grammar/spelling errors** | Professional organizations don't send sloppy emails |
| **Generic greeting** | "Dear Customer" instead of your name |
| **Mismatched tone** | A "bank" email that reads like a text message |

### Link Analysis
- [ ] Does the displayed URL match the actual URL? (hover vs href)
- [ ] Does the domain use **homoglyphs**? (e.g., `paypaI.com` with uppercase I instead of lowercase l)
- [ ] Does the domain use **typosquatting**? (e.g., `gooogle.com`, `micr0soft.com`)
- [ ] Does the URL use URL shorteners to hide the destination?
- [ ] Does the link point to an IP address instead of a domain?
- [ ] Does the URL have an unusual TLD? (`.xyz`, `.top`, `.buzz` for a supposed bank)
- [ ] Does the URL contain the real domain as a subdomain? (e.g., `apple.com.verify-account.xyz`)

### Attachment Analysis
- [ ] Is there an unexpected attachment?
- [ ] Does the file extension look suspicious? (`.exe`, `.scr`, `.js`, `.vbs`, `.html`)
- [ ] Is the attachment a double-extension? (`invoice.pdf.exe`)
- [ ] Does the attachment name create urgency? (`URGENT_invoice.pdf`)

## Output Format

```
## Phishing Analysis

### Sender
- Email: [actual sender address]
- Display name: [what the user sees]
- Domain check: [legitimate / suspicious / spoofed]

### Content Indicators
- [List each flag found, or "none detected"]

### Links Found
- Displayed: [what the user sees]
- Actual: [where it really goes]
- Domain age: [if checkable]
- Verdict: [safe / suspicious / malicious]

### Verdict: [Legitimate / Suspicious / Phishing]
**Confidence:** [High / Medium / Low]
**Reasoning:** [Specific evidence for the verdict]

### Recommended Action
- [What the user should do]
```

## Common Phishing Types

| Type | How It Works | Key Indicator |
|------|-------------|---------------|
| **Credential harvesting** | Fake login page mimicking a real service | URL doesn't match the real service domain |
| **BEC (Business Email Compromise)** | Impersonating a colleague or executive | Unusual request + slightly off email address |
| **Invoice fraud** | Fake invoice with attacker's bank details | Unexpected invoice, different bank details than usual |
| **Smishing** | SMS with malicious link | Short URL + urgency + from unknown number |
| **Spear phishing** | Targeted attack using personal details | Very convincing but asks for something unusual |
| **Clone phishing** | Copy of a real email with malicious link swapped in | Almost identical to a real email you received before |

## Guidelines

- Never tell the user "it's fine" without checking — false negatives are dangerous
- If uncertain, default to "suspicious — verify through an independent channel"
- "Independent channel" means contacting the supposed sender through a known-good method (their official website, a phone number you already have), NOT by replying to the suspicious message
- Check the actual URL, not the displayed text — these are often different in phishing emails
- A legitimate organization will never ask for your password via email
- If the email contains a link, suggest the user navigate to the service directly instead of clicking
