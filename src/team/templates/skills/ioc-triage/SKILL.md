---
name: ioc-triage
compatibility: Designed for FlopsyBot agent (aragorn primarily)
description: Systematic triage of Indicators of Compromise — hashes, IPs, domains, URLs. Use when a user submits any of these for reputation, threat-intel, or attribution lookup.
---

# IOC Triage

Pattern for triaging Indicators of Compromise into a verdict + severity + confidence, with one or two pivots so the verdict reflects the full picture, not the first lookup.

## When to Use This Skill

- User submits a hash (MD5/SHA1/SHA256/SHA512)
- User submits an IP address, domain, URL, or email address with security intent
- User says "is this safe / suspicious / malicious"
- User pastes a string that smells like an IOC (32/40/64/128 hex chars, IP-shaped, URL-shaped)

## The Triage Loop

```
identify type → primary lookup → pivot once or twice → verdict
```

Don't stop at the primary lookup. A single signal is rarely enough to commit to a verdict.

### Step 1 — Identify the IOC type

| Pattern | Likely type |
|---|---|
| 32 hex chars | MD5 |
| 40 hex chars | SHA1 |
| 64 hex chars | SHA256 |
| 128 hex chars | SHA512 |
| `x.x.x.x` (IPv4) or `x:x::x` (IPv6) | IP address |
| `*.example.com` | Domain |
| `https://...` | URL |
| `^[a-f0-9]{8,}$` and not a hash length | Possibly an artifact ID — confirm before treating as IOC |

If the type is ambiguous (e.g. a 16-char hex string), say so and ask gandalf to clarify before lookup.

### Step 2 — Primary lookup

| IOC type | Primary tool | What to read |
|---|---|---|
| Hash | VirusTotal | detection ratio, family attribution, behavior tab |
| IP | VirusTotal + Shodan | reputation, hosted services, ASN, geolocation |
| Domain | VirusTotal | reputation, WHOIS, related samples, subdomains |
| URL | VirusTotal | reputation, downloaded files, redirect chain |

Quote VT detection counts verbatim: "12/72 detections — `Trojan.Generic.X`". Never paraphrase the family name.

### Step 3 — Pivot ONCE or TWICE

Single signals are weak. Pivot before reporting.

**For a hash with detections:**
- Look up the family (e.g. "Emotet")
- Check Shodan for known C2 infrastructure of that family
- Check VT's behavior/relationships tab for related samples

**For a suspicious IP:**
- ASN reputation (residential vs datacenter vs known bulletproof hoster)
- Domains historically resolving to it (passive DNS via VT)
- Open ports (Shodan) — banner grabs may reveal C2 panels or RAT toolkits

**For a domain:**
- WHOIS — registration date (recently-registered domains for established brands = suspicious)
- IP it resolves to — pivot to Step 2 IP path
- Subdomains — bulk subdomain spam is a phish/exfil signal

**For a URL:**
- Strip to the domain — assess the domain
- Check for known phish kits in path patterns
- Check VT's URL submission history

Stop pivoting when you have enough for a verdict. Two pivots max unless evidence demands more.

### Step 4 — Compose the verdict

Required output (mandatory format from `roles/worker/security.md`):

```
**Verdict:** clean | suspicious | malicious | unknown
**Severity:** none | low | medium | high | critical
**Confidence:** low | medium | high

**Evidence:**
- Tool: <name> — <verbatim signal> — <source URL>
- Pivot: <what you found>
- ...

**Recommended action:** isolate / block / monitor / no action

**Open questions:** <what would change the verdict>
```

## Common Failure Modes

- **Stopping at the first lookup.** A clean VT result on a domain that's been alive for 12 hours is not "clean" — it's "no detections yet."
- **Treating low detections as clean.** 1/72 detections from a fringe AV is usually a false-positive, but cross-check before declaring clean.
- **Confusing severity with confidence.** A `critical` severity finding with `low` confidence is contradictory. Either the evidence supports critical (downgrade confidence high) or it doesn't (downgrade severity).
- **Hallucinating family attribution.** Only quote families that appear verbatim in tool output. "Emotet-like" is editorial; "VT detection: Trojan.Emotet.Generic" is evidence.
- **Skipping passive DNS / WHOIS on domains.** A registration-age check catches half the phishing domains in 30 seconds.
- **Forgetting the EICAR test file.** Hash `44d88612fea8a8f36de82e1278abb02f` is the EICAR test artifact — not real malware. If you see it, say so.

## Severity Calibration

| Verdict | Severity floor | Severity ceiling |
|---|---|---|
| `clean` | none | low (only if context demands it) |
| `suspicious` | low | medium |
| `malicious` | medium | critical |
| `unknown` | none | medium (never `high`/`critical` without evidence) |

`malicious + critical` should be reserved for: active C2, known APT infrastructure, ongoing exploitation campaigns. Don't inflate.

## Confidence Calibration

- **high** — 2+ corroborating signals (VT detections + Shodan match + family attribution match)
- **medium** — 1 strong signal (VT 10+ detections OR known C2 hit OR confirmed family)
- **low** — single weak signal (1-2 VT detections, single-source attribution, age-only signal)

Never claim `high` confidence on a single tool result.

## Sandbox Use (when available)

For samples that need deeper inspection beyond reputation:
- `strings` to extract hardcoded URLs, paths, mutex names
- `ssdeep` to find similar samples
- `yara` for family rule matching
- `objdump` / `readelf` for ELF inspection
- `exiftool` for document metadata

The sandbox is air-gapped — anything you generate stays in `/sandbox/output`. Never run untrusted code outside the sandbox; never on the host.

## Output Discipline

- Verdict first, evidence second. Always.
- Quote tool output verbatim — never paraphrase a detection name.
- Inconclusive is a valid verdict. Don't fabricate confidence to look helpful.
- If the IOC is benign and well-known (microsoft.com, google.com), say so plainly: `clean / none / high`.
