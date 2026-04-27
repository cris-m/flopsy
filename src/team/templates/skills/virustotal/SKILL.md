---
name: virustotal
compatibility: Designed for FlopsyBot agent
description: Investigate files, URLs, IPs, and domains for malware and threats using VirusTotal. Use when the user asks about suspicious files, phishing URLs, IP reputation, or domain safety.
---

# VirusTotal

Security intelligence via the VirusTotal API. Look up file hashes, scan URLs, check IP/domain reputation, and search threat intelligence.

## When to Use This Skill

- User asks "is this file safe?" or shares a hash (MD5/SHA-1/SHA-256)
- User wants to check if a URL is malicious or phishing
- User asks about an IP address's reputation or threat history
- User wants to verify if a domain is legitimate
- Security investigation: tracing malware, C2 infrastructure, or suspicious processes
- User says "scan this", "check this hash", "is this URL safe?"
- **Proactive:** You downloaded a file from the internet, a URL, or received one from a user — scan it before opening, executing, or forwarding it

## Tools

| Tool | Purpose | Input |
|------|---------|-------|
| `vt_file_report` | Look up file by hash | MD5, SHA-1, or SHA-256 |
| `vt_url_report` | Full URL security report (auto-submits if needed) | URL string |
| `vt_ip_report` | Check IP reputation | IPv4 or IPv6 address |
| `vt_domain_report` | Check domain reputation | Domain name |
| `vt_search` | Search VT intelligence | VT search query |

## Workflow

### File Investigation

1. Get the file hash (MD5, SHA-1, or SHA-256)
2. Call `vt_file_report` with the hash
3. Check the `stats` field: if `malicious > 0`, the file is flagged
4. Review `detections` to see which engines flagged it and why
5. Report the detection ratio (e.g., "12/72 engines detected this as malicious")

### URL Check

1. Call `vt_url_report` with the URL — it handles everything automatically (cached lookup, then submit + poll if needed)
2. Check `stats.malicious` — any non-zero count means at least one engine flagged it
3. Review `tags` for context clues like `"phishing"`, `"malware"`, `"tracker"`, `"redirector"`

### IP/Domain Reputation

1. Call `vt_ip_report` or `vt_domain_report`
2. Check `stats` for detection counts
3. Note `country`, `asOwner` for context
4. High `malicious` count = known bad infrastructure
5. Cross-reference with Shodan for port/service data if needed

### Proactive File Scanning (when YOU download a file)

Whenever you download a file from the internet or receive one from a user, **scan it before doing anything with it**. Don't wait for the user to ask — this is your responsibility as a local agent with file system access.

**When to scan:**
- You used `http_request` or `web_extract` to download a file
- User sent you a file attachment via a channel (document, APK, executable, archive)
- You're about to run `execute()` on a downloaded script
- You're about to forward a file to another user or channel

**Workflow:**

1. **Hash the file** — compute SHA-256 (preferred), MD5, or SHA-1:
```python
import hashlib
with open("/scratch/downloaded_file.exe", "rb") as f:
    sha256 = hashlib.sha256(f.read()).hexdigest()
print(f"SHA-256: {sha256}")
```

Via shell:
```
execute("sha256sum /scratch/downloaded_file.exe")
```

2. **Look it up on VirusTotal:**
```
vt_file_report({ hash: "<sha256_hash>" })
```

3. **Interpret and act:**

| Result | Action |
|--------|--------|
| 0 malicious, file known | Safe to proceed. Mention "scanned clean" to the user. |
| 0 malicious, file unknown | Proceed with caution. Tell the user "not in VT database — no known threats, but unverified." |
| 1-3 malicious | Warn the user. Show detection names. Ask before proceeding. |
| 4+ malicious | **Stop.** Do NOT execute, open, or forward the file. Alert the user with the detection details. |

4. **Report to the user** — always mention you scanned:
   - "I downloaded the file and scanned it — clean, no threats detected by any engine."
   - "Heads up — 3 engines flagged this file as potentially unwanted. Here's what they found: ..."
   - "This file is malicious (detected by 15/72 engines). I've NOT opened or executed it."

**Also scan URLs before visiting:**
If a user sends you a link to download or you find a download URL:
```
vt_url_report({ url: "https://example.com/file.exe" })
```
Check the results before downloading. If flagged, warn the user instead of downloading.

### Threat Hunting with Search

Use `vt_search` for intelligence queries:
- `"type:peexe p:5+"` — PE executables detected by 5+ engines
- `"engines:emotet"` — files detected as Emotet
- `"tag:exploit"` — files tagged as exploits
- `"submitter:US ls:7d"` — submitted from US in last 7 days

Note: Most search queries require a VT Premium API key.

## Interpreting Results

### Detection Stats

| Field | Meaning |
|-------|---------|
| `malicious` | Engines that flagged as malware/threat |
| `suspicious` | Engines that flagged as potentially unwanted |
| `harmless` | Engines that confirmed it as clean |
| `undetected` | Engines that returned no result |

### Risk Assessment

| Malicious Count | Assessment |
|----------------|------------|
| 0 | Clean — no engines detected a threat |
| 1-3 | Low risk — possible false positives, investigate further |
| 4-10 | Medium risk — multiple engines agree, likely malicious |
| 10+ | High risk — widely detected, almost certainly malicious |

### Key Fields

- **reputation**: Community score (negative = bad reputation)
- **tags**: VT-assigned tags (e.g., "peexe", "signed", "exploit")
- **detections**: Top engines that flagged it with their verdict
- **names**: Known filenames (for file reports)

## Guidelines

- Always report the detection ratio, not just "malicious" or "clean"
- A file with 0 detections is not guaranteed safe — it may be too new or too targeted
- Cross-reference IP/domain results with the Shodan skill for deeper network context
- When investigating a process (e.g., suspicious WebKit process), hash the binary and check VT
- For URLs, always use `vt_url_report` — it handles both cached lookup and fresh submission automatically
- VT search requires Premium API — if it returns an error, explain this to the user
- Never share raw API responses — use the summarized format from the MCP server
