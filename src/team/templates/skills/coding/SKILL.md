---
name: coding
compatibility: Designed for FlopsyBot agent
description: Problem-solving through code. Use when you can't solve a task with existing MCP tools alone — write quick scripts for data processing, API testing, calculations, automation, or prototyping. For multi-file projects or FlopsyBot codebase changes, delegate to the coder subagent instead.
---

# Coding — Problem-Solving Through Code

Write code to solve problems that your existing tools can't handle directly. Quick scripts, data transforms, API tests, calculations, automation — without delegating to the coder subagent every time.

> **ALWAYS RUN SAFE CODE.** Every script you write runs on the user's real machine with real data.
> Before executing ANY code, mentally verify: Does this script only read/write where it should?
> Could it delete, overwrite, or corrupt anything? Could it leak secrets? If in doubt, don't run it — ask the user first.

## Critical Operational Rules

These rules are NON-NEGOTIABLE. Every test failure traces back to breaking one of these.

### 1. NEVER tell the user to run commands — YOU run them
If a package is missing, create a venv and install it yourself:
```
execute("python3 -m venv /scratch/.venv")
execute("/scratch/.venv/bin/pip install matplotlib")
execute("/scratch/.venv/bin/python3 /scratch/chart.py")
```
WRONG: "You can install matplotlib by running `pip install matplotlib`"
RIGHT: Create venv → install → run script → report result → clean up venv when done.

### 2. NEVER hardcode data — ALWAYS fetch from the real source
If the task says "fetch from API X" → your script MUST call that API. Never type in fake/memorized data.
WRONG: `cryptos = [{"name": "Bitcoin", "price": 69884}]` (hardcoded from memory)
RIGHT: `resp = urllib.request.urlopen("https://api.coingecko.com/api/v3/...")` (live fetch)

### 3. ALWAYS verify output files have content
After writing or generating a file, CHECK IT:
```
execute("wc -c /scratch/output.csv")
```
If the file is 0 bytes → the script failed silently. Debug and retry. Do NOT tell the user "successfully converted" when the file is empty.

### 4. ALWAYS complete the FULL chain — never stop at text
If the user asks for audio → deliver an audio file, not a text file.
If the user asks for a chart → deliver an image, not a script.
If the user asks for a PDF → deliver a PDF, not markdown.
Check what API keys and tools you have. Write code to call them. Execute it. Deliver the actual artifact.

### 5. Log what you learned
After any failure or success, append a lesson to `/scratch/LESSONS.md`:
```
- [2026-02-15] matplotlib not pre-installed — always pip install --user before importing
```

### 6. ALL code output goes to /scratch/ — NOWHERE ELSE
ALL scripts, HTML, data files, and outputs go under /scratch/.
Do NOT create new top-level folders in /workspaces/ — that clutters the workspace.

WRONG: /Users/munzihirwa/.flopsy/crypto_portfolio/
WRONG: ~/crypto_portfolio/
WRONG: /workspaces/my-project/  (don't create new workspace folders)
RIGHT: /scratch/crypto_portfolio/
RIGHT: /scratch/report.html
RIGHT: /scratch/script.py

The /workspaces/ prefix maps to ~/.flopsy/workspaces/ automatically. Never use the real path.
Use subdirectories within scratch/ to organize (scratch/finance/, scratch/charts/, etc.)

### 7. Auto-open HTML files in the browser
When a script produces an HTML file, always open it so the user gets immediate visual feedback:
```
execute("open /scratch/report.html")  # macOS
```
Don't just report the file path — SHOW the result.

## Think Before You Say "Can't"

**You can write code. You have API keys. You have execute(). COMBINE THEM.**

Before telling the user you can't do something, run this decision tree:

```
User asks for X
  → Do I have a tool that does X directly? → USE IT
  → No direct tool, but do I have an API key for a service that does X?
    → YES → Write a script that calls that API. You have execute().
  → No API key, but can I chain tools together to get X?
    → YES → Plan the chain, write it, run it.
  → None of the above?
    → NOW you can say you can't — but explain what you checked.
```

**Common capability chains the agent misses:**

| User Wants | What You Have | What to Do |
|------------|---------------|------------|
| Audio file (poem, summary, etc.) | ElevenLabs or OpenAI API key | Write poem → write Python script calling TTS API → execute → return audio file |
| Image generation | OpenAI API key | Write a script calling DALL-E API → execute → return image |
| PDF report | Data + Python | Write script using `reportlab` or `fpdf` → execute → return PDF |
| Data visualization | Data + Python | Write script using `matplotlib` → execute → return chart image |
| File format conversion | Python stdlib | Write a conversion script → execute → return converted file |
| Scheduled automation | Scheduler tool + code | Write the script → schedule it with `schedule_bot_message` |

**The audio poem example — what SHOULD happen:**
1. Write the poem (you're good at this)
2. Check: does `ELEVENLABS_API_KEY` or `OPENAI_API_KEY` exist?
3. Write a Python script: `POST` to the TTS endpoint, save `.mp3` to `/scratch/poem.mp3`
4. `execute("python3 /scratch/tts-poem.py")`
5. Send the audio file to the user

**Never stop at step 1 and say "here's the text, use a TTS tool yourself."**

## When to Write Code

- **Data processing**: Parse, transform, or filter JSON, CSV, XML, or text
- **API testing**: Hit an endpoint, check a webhook, validate a response
- **Calculations**: Complex math, date arithmetic, financial formulas, unit conversions
- **Automation**: Batch operations, file renaming, repetitive tasks
- **Prototyping**: Quick proof-of-concept before delegating to coder for a full implementation
- **Environment checks**: Verify env vars, system state, installed packages, configs
- **Test data**: Generate fixtures, mock data, or sample payloads
- **Capability gap**: You don't have a direct tool, but you have an API key + execute() — write code to bridge the gap
- **Chaining**: Combine multiple tools/APIs to deliver something none of them can do alone

## When NOT to Write Code (Delegate to Coder Instead)

- Multi-file project changes or new features with tests
- Changes to FlopsyBot's own codebase
- Anything that needs git commits, PRs, or code review
- Complex projects requiring architecture decisions

Use: `task("coder", "description of the project-level task")`

## How to Run Commands

**Always use the `execute` tool to run commands.** Never tell the user to run commands themselves.

## Where to Save Code

| Type | Location | Lifecycle |
|------|----------|-----------|
| One-liner | Inline: `execute("python3 -c '...'")` | Ephemeral |
| Quick script | `/scratch/{descriptive-name}.py` | Cleaned up periodically |
| Node script | `/scratch/{descriptive-name}.mjs` | Cleaned up periodically |
| Bash script | `/scratch/{descriptive-name}.sh` | Cleaned up periodically |
| Persistent project | `/workspaces/projects/{project-name}/` | Kept across sessions |

## Language Guidance

**USE PYTHON BY DEFAULT.** Python has the richest stdlib and pip ecosystem. Node.js requires npm install for nearly everything, which creates MODULE_NOT_FOUND errors when packages aren't installed. Only use Node.js when the task is specifically about Node/TypeScript code or FlopsyBot internals.

| Language | Best For | When to Use |
|----------|----------|-------------|
| **Python** | API calls, data processing, charts, calculations, scraping, PDF/audio/image generation | **ALWAYS your first choice** — 90% of tasks |
| **Bash** | File operations, piping tools, system commands | Quick glue scripts, env checks |
| **Node.js** | FlopsyBot-adjacent code, TypeScript-specific tasks | **ONLY when Python can't do it** |

**Why Python wins for scripts:**
- `urllib.request` is built-in (no install needed for simple HTTP)
- `json`, `csv`, `os`, `sys`, `math`, `datetime` are all built-in
- `matplotlib`, `requests`, `pandas` are one `pip install` away in a venv
- Node.js without npm packages can barely make an HTTP request

## Safety Rules

**This code runs on a real machine. Always run safe code.**

### Before You Execute — Safety Checklist

Run this mentally before EVERY `execute()` call:

1. **File paths**: Does the script only touch `/workspaces/` or explicitly user-approved paths? If it touches `~/`, `/tmp/`, or system dirs — stop and ask.
2. **Destructive ops**: Does it delete, overwrite, or truncate files? If yes — confirm with user first, or use safe patterns (write to new file, then rename).
3. **Network calls**: Does it send data anywhere? Only make outbound requests the user explicitly asked for. Never exfiltrate data.
4. **Secrets**: Are API keys read from env vars / `.env`? Never hardcode, never log, never print secrets to output.
5. **Side effects**: Could this script change system state (install packages, modify configs, kill processes)? If yes — ask first.

### Hard Rules

1. **NEVER** write malicious code — no network attacks, no unauthorized access, no data exfiltration
2. **NEVER** hardcode secrets — read from environment variables or `.env` files
3. **NEVER** modify system files outside `/workspaces/` without explicit user approval
4. **NEVER** install packages globally — use a venv for Python, local `node_modules` for Node.js
5. **NEVER** run destructive shell commands (`rm -rf`, `sudo`, etc.) without user confirmation
6. **NEVER** execute code that sends user data to external services unless the user asked for it
7. **ALWAYS** clean up temporary files after one-off scripts
8. **ALWAYS** validate user input in scripts that accept external data
9. **ALWAYS** use safe file write patterns — write to temp file first, then rename, to avoid data loss on crash
10. **ALWAYS** add error handling — scripts should fail gracefully, not silently corrupt data

### Safe Code Patterns

```python
# SAFE: Write to temp file, then rename (atomic write)
import tempfile, os
with tempfile.NamedTemporaryFile(mode='w', dir='/workspaces/scratch', delete=False, suffix='.csv') as tmp:
    tmp.write(data)
    tmp_path = tmp.name
os.rename(tmp_path, '/scratch/output.csv')

# SAFE: Read-only operation with timeout
import urllib.request
with urllib.request.urlopen(url, timeout=10) as resp:
    data = resp.read()  # Read only, no side effects
```

**Red flags to watch for in your own code:**
- Any use of `shell=True` in subprocess calls
- Printing or logging environment variables containing keys/tokens
- Scanning all env vars (`env`, `printenv`, `os.environ.items()`) — this leaks secret names
- Writing files outside `/workspaces/` without user approval
- Running commands with user-supplied strings without sanitization

**Secrets rule**: Only check specific env vars you know the user needs. Report "set" or "NOT SET" — never the value, never the full list of configured keys.

## Environment Variables

- Check `~/.flopsy/.env` or project `.env` for existing variables
- Python: `os.environ.get('VAR_NAME')` or use `python-dotenv`
- Node.js: `process.env.VAR_NAME` or use `dotenv`
- If a script needs an API key, check if it's already configured before asking the user

```python
# Python pattern
import os
from dotenv import load_dotenv
load_dotenv(os.path.expanduser("~/.flopsy/.env"))
api_key = os.environ.get("OPENAI_API_KEY")
if not api_key:
    raise SystemExit("OPENAI_API_KEY not set in ~/.flopsy/.env")
```

```javascript
// Node.js pattern (.mjs)
import { config } from 'dotenv';
import { resolve } from 'path';
import { homedir } from 'os';
config({ path: resolve(homedir(), '.flopsy', '.env') });
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
```

## Workflow

1. **Can existing tools solve it?** If yes, use them — don't write code unnecessarily.
2. **Plan first if 4+ steps.** Multi-step tasks (fetch data → process → generate chart → build HTML → create audio) need a plan BEFORE you start coding.
   - Use `write_todos` to list every step with dependencies
   - For complex/ambiguous tasks → `task("planner", "break down: [task]")` first
   - Track each step: mark in_progress when starting, complete when done
   - **NEVER** just dive into a 5-step task without writing todos first
   Example for the finance snapshot task:
   ```
   write_todos([
     "Fetch live exchange rates from API",
     "Fetch live crypto prices from API",
     "Calculate $10K conversions for each currency/crypto",
     "Create venv, install matplotlib",
     "Generate bar chart comparing all values",
     "Generate HTML report with embedded chart + data table",
     "Generate audio file from analysis (check TTS API keys)",
     "Verify all output files have content"
   ])
   ```
3. **Pick the right language** for the task (see Language Guidance above).
4. **Ensure directory exists** — BEFORE writing any file:
   ```
   execute("mkdir -p /workspaces/scratch")
   ```
   This prevents "No such file or directory" failures. Do this every time — it's a no-op if it already exists.
5. **Write the script** to `/scratch/{descriptive-name}.{ext}` using `write_file()`.
6. **Verify the file was written** — read it back or check size:
   ```
   execute("wc -l /scratch/name.py")
   ```
   If it's empty or missing, something went wrong — fix before executing.
7. **Run it**:
   - Python: `execute("python3 /scratch/name.py")`
   - Node: `execute("node /scratch/name.mjs")`
   - Bash: `execute("bash /scratch/name.sh")`
8. **Verify output** — if the script produces a file, check it has content:
   ```
   execute("wc -l /scratch/output.csv")
   ```
   An empty output file means the script didn't work. Debug and retry (up to 3 attempts).
9. **Auto-open HTML** — if the script produced an HTML file, open it: `execute("open /scratch/output.html")`
10. **Report results** to the user using the Output Format below.
11. **Clean up** if the script was one-off: `execute("rm /scratch/name.py")`

## Output Format

When presenting coding results, use this structured format. Don't just dump raw output — present it like a build showcase.

**Template:**
```
🛠️ CODING TASK

Project: {descriptive name}
Location: /scratch/{filename}

What It Does:
{1-2 sentence description of what the script does}

Key Files:
• {filename} ({size}) — {what it does}
• {output-file} ({size}) — {what was produced}

Result:
{formatted output — the actual answer to the user's question}

Usage:
[code block showing how to run it again]
```

**Rules for output:**
- ALWAYS show the file path where the script lives
- ALWAYS show the output file path if one was created
- ALWAYS include the actual result/answer — don't make the user go read files
- Show file sizes so the user knows something was actually written
- Include a usage block so the user can re-run the script later
- For data outputs (CSV, JSON), show a preview (first 5 rows) inline + the file path

**Example — CSV conversion result:**
```
🛠️ CODING TASK

Project: JSON to CSV Converter
Location: /scratch/json-to-csv.py

What It Does:
Converts JSON array to CSV format with automatic header detection.

Key Files:
• json-to-csv.py (0.4KB) — Conversion script
• data.csv (0.1KB) — Output CSV

Result:
Converted 3 rows successfully.

Preview:
name,age
Alice,30
Bob,25
Carol,35

Full file: /scratch/data.csv

Usage:
python3 /scratch/json-to-csv.py
```

## Fact-Checking Integration

When code output produces facts, statistics, or real-world claims:

1. Run the script and get the result
2. If the result contains factual claims (API data, scraped content, statistics) — verify before sharing
3. Delegate: `task("swarm", "fact-checker-agent: Verify these claims: [list claims from output]")`
4. Share verified results with the user, noting any unverified claims

**Don't fact-check**: Pure calculations, file operations, data transforms (these are deterministic).
**Do fact-check**: API responses with factual data, scraped web content, any "X company did Y" claims.

## Examples

### 1. Quick API Test (Python)

**Scenario**: User asks "does this API endpoint work?"

```python
# /scratch/api-test.py
import urllib.request
import json

url = "https://api.example.com/health"
try:
    req = urllib.request.Request(url, headers={"User-Agent": "FlopsyBot/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
        print(f"Status: {resp.status}")
        print(f"Response: {json.dumps(data, indent=2)}")
except Exception as e:
    print(f"Failed: {e}")
```

Run: `execute("python3 /scratch/api-test.py")`

### 2. Data Transformation — JSON to CSV (Python)

**Scenario**: User has JSON data and needs it as CSV.

```python
# /scratch/json-to-csv.py
import json
import csv
import sys

input_file = "/scratch/data.json"
output_file = "/scratch/data.csv"

with open(input_file) as f:
    data = json.load(f)

if not data:
    sys.exit("Empty JSON")

# Use first item's keys as headers
keys = list(data[0].keys())
with open(output_file, "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=keys)
    writer.writeheader()
    writer.writerows(data)

print(f"Converted {len(data)} rows -> {output_file}")
```

### 3. Environment Check (Bash)

**Scenario**: Verify the system has the right tools installed.

```bash
#!/bin/bash
# /scratch/env-check.sh
echo "=== Installed Tools ==="
echo "Python: $(python3 --version 2>&1 || echo 'NOT FOUND')"
echo "Node:   $(node --version 2>&1 || echo 'NOT FOUND')"
echo "npm:    $(npm --version 2>&1 || echo 'NOT FOUND')"
echo "git:    $(git --version 2>&1 || echo 'NOT FOUND')"
echo ""
echo "=== API Keys (presence only) ==="
# ONLY check specific known keys — report "set" or "NOT SET"
# NEVER print key values. NEVER scan/list all env vars.
[ -n "$OPENAI_API_KEY" ] && echo "OPENAI_API_KEY: set" || echo "OPENAI_API_KEY: NOT SET"
[ -n "$ANTHROPIC_API_KEY" ] && echo "ANTHROPIC_API_KEY: set" || echo "ANTHROPIC_API_KEY: NOT SET"
```

**CRITICAL**: Never scan all environment variables (e.g., `env | grep KEY`). This leaks what services the user has configured. Only check specific, known variables by name, and only report "set" or "NOT SET" — never the value.

### 4. Date/Time Calculation (Node.js)

**Scenario**: User asks "how many business days between two dates?"

```javascript
// /scratch/business-days.mjs
const start = new Date(process.argv[2] || '2025-01-06');
const end = new Date(process.argv[3] || '2025-01-31');
let count = 0;
const current = new Date(start);

while (current <= end) {
  const day = current.getDay();
  if (day !== 0 && day !== 6) count++;
  current.setDate(current.getDate() + 1);
}

console.log(`Business days from ${start.toISOString().slice(0,10)} to ${end.toISOString().slice(0,10)}: ${count}`);
```

Run: `execute("node /scratch/business-days.mjs 2025-03-01 2025-03-31")`

### 5. Web Scraping Snippet (Python)

**Scenario**: Extract specific data from a web page.

```python
# /scratch/scrape.py
import urllib.request
import re

url = "https://example.com"
req = urllib.request.Request(url, headers={"User-Agent": "FlopsyBot/1.0"})
with urllib.request.urlopen(req, timeout=15) as resp:
    html = resp.read().decode()

# Extract title
title = re.search(r"<title>(.*?)</title>", html)
print(f"Title: {title.group(1) if title else 'not found'}")

# Extract all links
links = re.findall(r'href="(https?://[^"]+)"', html)
print(f"\nFound {len(links)} links:")
for link in links[:10]:
    print(f"  {link}")
```

**Important**: Fact-check any factual claims from scraped content before sharing.

### 6. File Processing — Filter and Rename (Python)

**Scenario**: Batch rename files matching a pattern.

```python
# /scratch/batch-rename.py
import os
import re

directory = "/scratch/files"
pattern = r"IMG_(\d{4})(\d{2})(\d{2})_(\d+)"
renamed = 0

for filename in os.listdir(directory):
    match = re.match(pattern, filename)
    if match:
        year, month, day, seq = match.groups()
        ext = os.path.splitext(filename)[1]
        new_name = f"{year}-{month}-{day}-{seq}{ext}"
        os.rename(
            os.path.join(directory, filename),
            os.path.join(directory, new_name)
        )
        print(f"  {filename} -> {new_name}")
        renamed += 1

print(f"\nRenamed {renamed} files")
```

## Common Pitfalls

These are real failures from testing. Learn from them.

| Pitfall | What Happens | Fix |
|---------|-------------|-----|
| Using Node.js for API calls | MODULE_NOT_FOUND — axios/fetch not available | **Use Python** with `urllib.request` (built-in) |
| Hardcoding data instead of fetching | User gets stale/wrong numbers | Always `urllib.request.urlopen(api_url)` for live data |
| Telling user "install matplotlib" | User has to do your job | Create venv, pip install, run with venv python |
| Writing text when user asked for audio | Incomplete chain | Check TTS API keys → write script → execute → deliver file |
| Script path errors | File not found / MODULE_NOT_FOUND | Always use full paths: `/scratch/name.py` |
| Empty output files | Script failed silently | Always `wc -c` after generating files |
| Using `node` without npm packages | MODULE_NOT_FOUND errors | Switch to Python — it has better stdlib |

**Rule of thumb:** If you're about to use Node.js, ask yourself: "Can Python do this?" The answer is almost always yes, with fewer dependencies.

## Debugging Failed Scripts

**DO NOT loop more than 3 times on the same error.** If you've tried the same fix 3 times, STOP and change strategy entirely.

1. **Read the FULL error** — not just the first line. The root cause is often in the middle of the traceback.
2. **Reproduce before fixing** — run the exact same command again to confirm the error. If you can't reproduce, you can't verify a fix.
3. **Isolate the problem** — change ONE thing at a time. Don't make multiple speculative fixes simultaneously.
4. **Work backwards** — if the output is wrong, trace where the bad value came from. Don't add special-case checks for symptoms.
5. **Check inputs** — does the input file exist? Are env vars set? Is the API returning data?
6. **Fix and retry** — edit the script, run again. If it fails again with the SAME error → your fix didn't work → try a completely different approach.
7. **If going in circles** — STOP. Report what you tried, the exact errors, and ask the user for guidance.

**Common script failures and real fixes:**
- `MODULE_NOT_FOUND` (Node.js) → Switch to Python. Python stdlib covers most use cases without npm install.
- `ModuleNotFoundError` (Python) → Create venv, pip install, run with venv python. Never tell user to install.
- `FileNotFoundError` → Run `mkdir -p` on the directory first. Use absolute paths.
- `0 byte output file` → Script ran but produced nothing. Add print statements to trace where it stopped.
- `Timeout` → API might be rate-limited. Add retry with backoff, or try a different API.

## Installing Dependencies

**YOU install them. NEVER tell the user to do it.**

Use **isolated environments** so the user's system stays clean. Install what you need, run the script, clean up after.

### Python — Virtual Environment

Create a venv in `/scratch/.venv/`, install into it, run with its Python. Delete when done.

```
# Setup (once per session or when .venv doesn't exist)
execute("python3 -m venv /scratch/.venv")
execute("/scratch/.venv/bin/pip install matplotlib requests")

# Run scripts with the venv Python
execute("/scratch/.venv/bin/python3 /scratch/chart.py")

# Cleanup when done (optional — or leave for reuse)
execute("rm -rf /scratch/.venv")
```

**Pattern for scripts that need packages:**
```
Step 1: execute("python3 -m venv /scratch/.venv")          ← create env
Step 2: execute("/scratch/.venv/bin/pip install pandas")    ← install deps
Step 3: execute("/scratch/.venv/bin/python3 script.py")     ← run script
Step 4: execute("rm -rf /scratch/.venv")                    ← cleanup
```

If the venv already exists, skip step 1 — just install and run.

### Node.js — Local node_modules

Install packages locally in `/scratch/`. Delete `node_modules` when done.

```
# Setup
execute("cd /workspaces/scratch && npm init -y && npm install axios cheerio")

# Run
execute("node /scratch/fetch-data.mjs")

# Cleanup
execute("rm -rf /scratch/node_modules /scratch/package.json /scratch/package-lock.json")
```

### Common Packages

| Package | Language | Install | Use Case |
|---------|----------|---------|----------|
| matplotlib | Python | `pip install matplotlib` | Charts, graphs, visualizations |
| requests | Python | `pip install requests` | HTTP requests |
| pandas | Python | `pip install pandas` | Data analysis, CSV/Excel |
| reportlab | Python | `pip install reportlab` | PDF generation |
| Pillow | Python | `pip install Pillow` | Image processing |
| elevenlabs | Python | `pip install elevenlabs` | TTS audio generation |
| openai | Python | `pip install openai` | OpenAI API (images, TTS) |
| axios | Node.js | `npm install axios` | HTTP requests |
| cheerio | Node.js | `npm install cheerio` | HTML parsing |

### Rules
- **NEVER** install globally. No `sudo pip`, no `npm install -g`.
- **NEVER** tell the user to install packages — you do it.
- **ALWAYS** use the venv Python (`/scratch/.venv/bin/python3`) — not the system `python3`.
- **ALWAYS** clean up after one-off tasks: delete the venv, delete `node_modules`.
- For persistent projects in `/workspaces/projects/{name}/`, keep the venv — don't delete it.

## End-to-End Example: Multi-Step Data Task

**Task**: "Fetch live crypto prices, calculate conversions, generate a chart and HTML report"

**Correct approach** (ALL Python, one script, venv for matplotlib):

```
Step 1: write_file("/scratch/finance-snapshot.py", """
import urllib.request, json, os, base64

# 1. FETCH LIVE DATA (never hardcode)
crypto_url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd"
fx_url = "https://open.er-api.com/v6/latest/USD"

with urllib.request.urlopen(crypto_url, timeout=15) as r:
    crypto = json.loads(r.read())
with urllib.request.urlopen(fx_url, timeout=15) as r:
    fx = json.loads(r.read())

btc = crypto['bitcoin']['usd']
eth = crypto['ethereum']['usd']
eur = fx['rates']['EUR']
gbp = fx['rates']['GBP']
jpy = fx['rates']['JPY']

amount = 10000

# 2. CALCULATE
conversions = {
    'EUR': amount * eur,
    'GBP': amount * gbp,
    'JPY': amount * jpy,
    'BTC': amount / btc,
    'ETH': amount / eth,
}

# 3. GENERATE CHART (matplotlib via venv)
import matplotlib
matplotlib.use('Agg')  # Non-interactive backend
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(10, 6))
labels = list(conversions.keys())
values = list(conversions.values())
ax.bar(labels, values, color=['#2196F3','#4CAF50','#FF9800','#F44336','#9C27B0'])
ax.set_title(f'$10,000 USD Converted')
ax.set_ylabel('Value')
plt.tight_layout()
chart_path = '/scratch/finance/chart.png'
os.makedirs('/scratch/finance', exist_ok=True)
plt.savefig(chart_path, dpi=150)
print(f'Chart saved: {chart_path}')

# 4. GENERATE HTML REPORT with embedded chart
with open(chart_path, 'rb') as f:
    chart_b64 = base64.b64encode(f.read()).decode()

html = f'''<!DOCTYPE html>
<html><head><title>Finance Snapshot</title>
<style>body{{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px}}
table{{width:100%;border-collapse:collapse}}th,td{{padding:8px;border:1px solid #ddd;text-align:left}}
th{{background:#333;color:#fff}}</style></head>
<body><h1>Finance Snapshot</h1>
<img src="data:image/png;base64,{chart_b64}" width="100%">
<table><tr><th>Currency</th><th>$10,000 USD =</th></tr>
<tr><td>EUR</td><td>{conversions["EUR"]:,.2f}</td></tr>
<tr><td>GBP</td><td>{conversions["GBP"]:,.2f}</td></tr>
<tr><td>JPY</td><td>{conversions["JPY"]:,.0f}</td></tr>
<tr><td>BTC</td><td>{conversions["BTC"]:.6f}</td></tr>
<tr><td>ETH</td><td>{conversions["ETH"]:.4f}</td></tr>
</table>
<p>BTC at ${btc:,.0f}, ETH at ${eth:,.2f}. Rates from CoinGecko + ExchangeRate API.</p>
</body></html>'''
html_path = '/scratch/finance/report.html'
with open(html_path, 'w') as f:
    f.write(html)
print(f'HTML saved: {html_path}')
print(f'BTC: ${btc:,} | ETH: ${eth:,.2f} | EUR: {eur} | GBP: {gbp} | JPY: {jpy}')
""")

Step 2: execute("python3 -m venv /scratch/.venv")
Step 3: execute("/scratch/.venv/bin/pip install matplotlib")
Step 4: execute("/scratch/.venv/bin/python3 /scratch/finance-snapshot.py")
Step 5: execute("wc -c /scratch/finance/chart.png /scratch/finance/report.html")
Step 6: Report results to user with file paths
```

**Notice:**
- ALL Python — no Node.js, no npm
- Live API calls — no hardcoded prices
- Venv for matplotlib — no telling user to install
- Output verification — wc -c to confirm files have content
- One self-contained script — no fragmented steps

## Guidelines

- Prefer stdlib over external packages for simple tasks (Python's `urllib` over `requests` for a single GET)
- Write scripts that are self-contained — no external state assumptions
- Add a shebang line to bash scripts: `#!/bin/bash`
- Use descriptive filenames: `api-test-stripe.py` not `test.py`
- For anything beyond ~50 lines or needing tests, delegate to coder subagent
