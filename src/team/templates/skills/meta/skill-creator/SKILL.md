---
name: skill-creator
category: meta
compatibility: Designed for FlopsyBot agent
description: "Guide for authoring, validating, and refining SKILL.md files. Use when the user asks to add a new capability, write a new skill, update an existing skill, codify a repeated procedure, or document a recurring gotcha — even if they don't explicitly say the word 'skill'."
when-to-use: "Use BEFORE calling skill_manage(create) or when revising a skill. Covers frontmatter shape, layout, size limits, content patterns, and how to write a description that triggers reliably."
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

# Skill Creator

How to author SKILL.md files that match FlopsyBot's runtime, follow the agentskills.io conventions, and trigger reliably.

## When to use this skill

- The user asks to add a new capability or workflow
- An existing skill needs updates, a new gotcha, or new lessons
- You spot a multi-step procedure the agent keeps re-deriving — codify it
- A correction the user made should not be forgotten next time

## Skill location

Skills live under `.flopsy/content/skills/<category>/<skillName>/SKILL.md`. The runtime scans this tree on boot and per-turn. Categories are flat one-level groups:

```
.flopsy/content/skills/
  channels/        — per-channel rendering rules (one per platform)
  delegation/      — worker handoff conventions
  macos/           — macOS-specific automation
  media/           — Spotify, TTS, image generation
  memory/          — memory tool patterns
  meta/            — skills about authoring skills (this file lives here)
  output/          — output formatting conventions
  productivity/    — Google Workspace, Obsidian, scheduler, email
  research/        — research, summarization, web-access
  security/        — security workflows
```

Pick the closest existing category; only invent a new one if nothing fits. The `category:` frontmatter field MUST match the directory name.

A skill's own subtree looks like:

```
.flopsy/content/skills/research/my-skill/
  SKILL.md              <- required: the main skill document
  reference/            <- optional: detail files loaded on demand
    api.md
  scripts/              <- optional: bundled reusable scripts
```

## SKILL.md frontmatter (the real schema)

```yaml
---
name: my-skill                          # REQUIRED, kebab-case, == directory name
category: research                      # REQUIRED, == parent directory name
compatibility: Designed for FlopsyBot agent   # REQUIRED, literal string
description: "..."                      # REQUIRED, ≤1024 chars, see "Writing descriptions"
when-to-use: "..."                      # REQUIRED, one-line trigger reference
metadata:
  flopsy:
    agent-affinity: [gandalf]           # OPTIONAL, [*] universal, [name1, name2] specific agents
# Optional:
version: "1.2"                          # SemVer; bumped by skill_manage(bump_version)
requires_toolsets: [web]                # Hidden unless agent has ALL these toolsets bound
fallback_for_toolsets: [research]       # Hidden when agent ALREADY has this toolset
platforms: [darwin, linux]              # Hidden when host platform not in this list
prerequisite_commands: [pdfplumber]     # Hidden when the command is not on PATH
bundled-equivalents: [web-extract, web-research]   # Peer skills loaded together when this ranks high
allowed-tools: [web_search, web_extract]           # Optional: tool allowlist for the skill's workflow
---
```

### Required fields

- **name** — kebab-case slug, ≤64 chars, matches the directory name exactly. The interceptor rejects skills where frontmatter `name` and the directory differ.
- **category** — the parent directory name. Used by the writer + catalog to place + display the skill.
- **compatibility** — literal `Designed for FlopsyBot agent`.
- **description** — see [Writing descriptions](#writing-descriptions). ≤1024 chars.
- **when-to-use** — single sentence reference shown in the catalog table.

### Optional but powerful (conditional activation)

`requires_toolsets`, `fallback_for_toolsets`, `platforms`, `prerequisite_commands` let the runtime hide the skill from agents that can't use it — keeps catalogs lean and prevents the model from picking a skill it'd fail to execute.

## Size cap (enforced)

- **Hard cap: 500 lines.** `skill_manage(create)` and `skill_manage(patch)` REFUSE writes that exceed this. Every active skill's metadata loads into the catalog block every turn; oversize skills bloat it. Matches agentskills.io's ≤500 lines / ≤5000 tokens guidance.
- For more content, use **progressive disclosure**: keep `SKILL.md` to the core path, move detail into `reference/<topic>.md`, and tell the agent exactly when to load each file:
  > "If the API returns a non-200 status, read `reference/api-errors.md` for recovery procedures."

  Generic "see reference/ for details" is worse than nothing — the model doesn't know what to look for or when.

## Recommended body structure

```markdown
# Skill Title

One-line summary of what this skill enables.

## When to use this skill
- Concrete trigger phrases
- Conditions where this skill applies
- Conditions where it does NOT apply (sharpens the boundary)

## Workflow
Step-by-step. Prefer procedures over declarations.

## Gotchas
Environment-specific facts that defy reasonable assumptions.

## Validation
How the agent checks its own work before finishing.

## Tools (optional)
| Tool | Purpose |

## Lessons Learned
(Auto-managed by skill_manage(append_lessons) — capped at 20 newest.)
```

## Content patterns

Load-bearing patterns across FlopsyBot skills. Use the ones that fit.

### Gotchas section (highest-leverage pattern)

A "Gotchas" section captures environment-specific facts the model would otherwise get wrong by following its general instincts. NOT general advice — concrete corrections to mistakes you've actually seen:

```markdown
## Gotchas

- The `users` table uses soft deletes. Queries MUST include
  `WHERE deleted_at IS NULL` or results include deactivated accounts.
- The user ID is `user_id` in the DB, `uid` in the auth service,
  and `accountId` in the billing API. All three are the same value.
- `/health` returns 200 as long as the web server runs, even if the DB
  is down. Use `/ready` for full service health.
```

Gotchas live in SKILL.md (not a reference file) so the model sees them BEFORE making the mistake. When the user corrects a recurring mistake, `skill_manage(patch)` it into Gotchas — NOT `append_lessons` (that's for outcome-derived corrections from the self-improve heartbeat).

### Validation loops

For skills producing structured output (config, SQL, JSON, PR bodies), formalize a validation step:

```markdown
## Workflow
1. Make the edits.
2. Run the validator: `python scripts/validate.py output/`
3. If it fails: read the error, fix the named issue, re-run.
4. Only proceed to delivery when validation passes.
```

### Plan-validate-execute (fragile/destructive ops)

For migrations, bulk edits, deletes — three steps: (1) produce a structured plan (e.g. `field_values.json`); (2) validate it against a source-of-truth with a script whose errors name what's wrong; (3) execute only after validation passes. Errors like `Field 'signature_date' not found — available: customer_name, order_total` steer the model to the right fix.

### Defaults, not menus

Pick one default, mention alternatives as fallbacks:

```markdown
Use `pdfplumber`. For scanned documents fall back to `pdf2image` + `pytesseract`.
```

NOT `You can use pypdf, pdfplumber, PyMuPDF, or pdf2image…` — equal-options forces a slow, sometimes-wrong runtime choice.

### Templates for output format

When the agent must produce a specific format, give a literal template — agents pattern-match concrete structures more reliably than prose.

### Match specificity to fragility

- **Give freedom** when multiple approaches are valid ("look for SQL injection in any query touching user input" — describe what, not how).
- **Be prescriptive** when sequence matters ("Run EXACTLY: `python scripts/migrate.py --verify --backup`. Do not add flags.").

### Add what the agent lacks, omit what it knows

Don't explain HTTP, PDF, git. Spend lines on project schemas, domain procedures, non-obvious edge cases, and the specific tools/APIs to use. Ask of every paragraph: *would the agent get this wrong without it?* If no, cut it.

## Writing descriptions

The `description` is the trigger surface. The runtime loads only `name` + `description` into the catalog every turn; the full SKILL.md loads only when the model decides to read it. **Under-specific = never fires. Over-broad = fires for the wrong queries.**

- **Imperative phrasing.** `"Use when the user wants to ..."` not `"This skill provides ..."`.
- **Focus on user intent, not implementation.** The agent matches what the user asked for.
- **Err pushy.** List phrasings the user might use without naming the domain: `"... even if they don't explicitly mention 'CSV'."`
- **Concise.** ≤1024 chars hard limit; 200-400 is the sweet spot.
- **Include trigger phrases.** Real ways a user might ask.

Bad: `description: "PDF processing."`
Good: `description: "Extract text, tables, and forms from PDF files — including scanned PDFs requiring OCR. Use when the user asks to read, extract, search, or summarize PDF content, or attaches a .pdf, even when they don't say 'PDF'."`

### description vs when-to-use

| Field | Loaded into | Length | Who reads it |
|---|---|---|---|
| `description` | static catalog (every turn) | ≤1024 | agent at trigger-decision time |
| `when-to-use` | catalog table row | one sentence | agent disambiguating similar skills |

`description` is your trigger advertisement — capture every realistic phrasing. `when-to-use` is the one-line reminder. If you can only write one well, write `description`.

### Iterating on a description

If a skill fires too rarely → too narrow; broaden scope + add intent phrasings. Too eagerly → too broad; add what it does NOT do, sharpen the boundary vs adjacent skills. Don't paste failing-query keywords verbatim (overfitting) — address the general intent they share.

## Bundled scripts

When a skill needs reusable logic (env setup, multi-step pipelines, output parsing), bundle it in `scripts/` instead of inlining 30 lines in the body. The agent reliably runs `bash scripts/foo.sh`; it routinely botches a 30-line `execute_code` block.

### Required convention

1. **List every bundled script** in an `## Available scripts` section (the agent only sees what you list):
   ```markdown
   ## Available scripts
   - **`scripts/speak.sh`** — Generate WAV from text. Wraps the uv + env setup.
   ```
2. **Use relative paths from the skill root** in commands (`scripts/speak.sh`), not absolute mount paths.
3. **Wrap complex invocation in a shell script**, not the SKILL.md body.

### Script design rules (agentskills.io standard)

- **No interactive prompts** — the sandbox is non-interactive; a prompt hangs the agent. Take input via flags / env / stdin; reject missing args with a clear error.
- **`--help` is the agent's docs** — concise, list flags, one example.
- **Helpful errors** — `"--format must be one of: json, csv, table. Received: 'xml'"`.
- **Structured stdout, diagnostics on stderr** — JSON/TSV to stdout, progress to stderr.
- **Idempotent by default** — agents retry; "create if not exists" beats "create or fail".
- **`--dry-run` for destructive ops.**
- **Meaningful exit codes**, documented in `--help`.
- **Predictable output size** — cap large output; offer `--output <file>`/`--offset`. Harnesses truncate beyond ~10-30K chars.

### When to inline vs bundle

Inline a one-liner. Bundle when the command grows past ~3 flags, needs env setup, threads multiple commands, or you're tempted to wrap it in `execute_code`.

## Auto-promotion via evals (proposed → active)

Agent-authored skills land in `proposed/`. Promotion gates on **evals** — a small benchmark showing the skill measurably helps. A proposed skill that wants auto-promotion includes `evals/evals.json` next to SKILL.md:

```json
{
  "skill_name": "csv-analyzer",
  "evals": [
    {
      "id": 1,
      "prompt": "I have ~/data/q4.csv with revenue in col C — top 3 months and a bar chart?",
      "expected_output": "A bar chart of top 3 months; both axes labeled.",
      "assertions": ["output includes a chart image", "chart shows exactly 3 months", "both axes labeled"]
    }
  ]
}
```

### Promotion criteria (all must hold)

- **≥3 evals** with assertions
- **with-skill pass rate ≥ without-skill + 0.30** — must demonstrably help, not just match baseline
- **No regression** — every assertion passing without the skill still passes with it
- **Cost ceiling** — with-skill tokens ≤ 3× without-skill

Run via `flopsy skill proposed promote <name>` (eval gate) or `flopsy skill eval <name>` (run-only).

### Assertions

Programmatically verifiable ("valid JSON", "row count == 3", "file exists .wav"), specific & observable ("Y-axis labeled"). NOT vague ("output is good"). Accepted forms: plain string (substring), `{contains}`, `{regex,flags}`, `{file_exists}`.

### Iterating a failing skill

Read the execution transcript to see WHY (not just WHAT failed). Generalize the fix — don't paste the failing prompt's keywords. Apply via `skill_manage(patch)`. Re-run; promote when criteria pass.

## Creating a new skill

1. Pick the category (reuse an existing one).
2. Draft `SKILL.md` (under 500 lines).
3. `skill_manage(operation="create", skillName="my-skill", content="...")`. The writer refuses if it already exists / exceeds 500 lines / contains critical danger patterns; ensures `name` matches; writes atomically.
4. Restart the gateway so the catalog re-scans (or `flopsy skill reload`).

## Updating an existing skill

| Goal | Tool |
|---|---|
| Refine a section | `skill_manage(patch, ...)` — exact find/replace, refuses on ambiguous matches |
| Bump version | `skill_manage(bump_version, version="1.2")` |
| Add outcome-derived lesson | `skill_manage(append_lessons, ...)` (cap 20, deduped) |
| Hide from catalog | `skill_manage(archive)` |
| Protect from auto-archive | `skill_manage(pin)` |

## Anti-patterns

- ❌ Generic advice ("handle errors carefully") — say WHAT and HOW
- ❌ Comprehensive every-edge-case coverage — cover the ones that defy assumptions; let model judgment handle the rest
- ❌ Menus of equal-weight tools — pick a default
- ❌ Verbose "This skill provides functionality for..." descriptions — be imperative, user-intent
- ❌ Path = `packages/agent/skills/...` (legacy drift) — real path is `.flopsy/content/skills/<category>/<skill>/`
- ❌ Skipping `category:` — the writer can't place it + the interceptor won't find it
- ❌ Time-bound content (Q4 2024 specifics) — skills are reusable across time; ephemeral context goes in MEMORY.md
- ❌ Cross-skill dependencies without `bundled-equivalents` — declare them so the catalog keeps families grouped
