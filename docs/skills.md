# Skills

A **skill** is a reusable knowledge + instructions chunk an agent loads on demand. Skills are plain markdown files under `.flopsy/content/skills/<name>/SKILL.md`. The catalog scans this directory at boot and the agent reads bodies via tool calls or proactive-fire frontmatter.

## Three sibling directories

```
.flopsy/content/
├── skills/                  # ACTIVE — agents can see + use these
├── skills-optional/         # BUNDLED but inactive — install with `flopsy skill install <name>`
└── skills-proposed/         # AGENT-AUTHORED — pending human review
```

| Path | Who writes | Who reads | Lifecycle |
|---|---|---|---|
| `skills/` | Operator (hand-authored), `skill_manage(create)`, or `flopsy skill install` | Agents | Active → stale (30d no read) → archived (90d no read) via curator |
| `skills-optional/` | Bundled with FlopsyBot | Promoted to `skills/` on install | Static |
| `skills-proposed/` | `SessionExtractor` at session close (`/new`) OR worker via `skill_manage(create)` | Operator reviews with `flopsy skill proposed` | Manual `accept` → `skills/` or `reject` → deleted |

## Anatomy of a skill

```
.flopsy/content/skills/
└── coding/
    ├── SKILL.md         # required — frontmatter + body
    ├── references/      # optional — supporting docs the body links
    ├── scripts/         # optional — runnable scripts the agent can invoke
    └── templates/       # optional — file scaffolds
```

A minimal `SKILL.md`:

```markdown
---
name: coding
description: Problem-solving through code. Use when you can't solve a task with existing MCP tools alone.
---

# Coding — Problem-Solving Through Code

Write code to solve problems that your existing tools can't handle directly.
Quick scripts, data transforms, API tests, calculations, automation.

## Critical Operational Rules
1. NEVER tell the user to run commands — YOU run them.
2. ...
```

Frontmatter fields (only `name` and `description` are required):

| Field | Required | Purpose |
|---|---|---|
| `name` | ✅ | kebab-case slug. Must match the directory name. |
| `description` | ✅ | One-line summary used in the catalog + skill-routing decisions. |
| `compatibility` | optional | Free-form text — typically `Designed for FlopsyBot agent`. |
| `version` | optional | semver bumped by `skill_manage(bump_version)`. |
| `when_to_use` | optional | Trigger description (also embedded inside the body for some skills). |

There is **no** `triggers: [...]` array or `agents: [...]` restriction in the live schema. Catalog scoping happens at job level (proactive fires bind skills via job frontmatter `skills:`) or via DCL match.

## How skills reach the agent

There are three load paths:

1. **Job-bound (proactive)** — a cron/heartbeat job's frontmatter lists `skills: [name1, name2]`. The proactive executor reads those bodies and prepends them as `<active_skills>` for that fire only.

2. **Agent-driven (interactive)** — the agent calls `skill_manage(operation: 'view', skillName: 'X')` mid-turn to load a body. Or DCL (Dynamic Catalog Loading) matches a skill description to the user's query.

3. **Curator-tracked usage** — every view bumps `view_count` in `.skill-state.json`; the curator transitions skills active → stale → archived based on age + activity.

## Skill curator

Runs at session close (`runSkillCurator` in `src/team/src/harness/review/skill-curator.ts`). Only touches **agent-created** skills (`is_agent_created: true`); hand-authored skills are never auto-archived.

| Trigger | Transition |
|---|---|
| `last_viewed_at` older than 30 days, state = `active`, not pinned | → `stale` |
| `last_viewed_at` older than 90 days, state = `stale`, not pinned | → `archived` |
| Skill viewed | → `active` (reactivates from any state) |

Archived skills stay on disk but the catalog hides them. Pinned skills bypass everything — `skill_manage(pin, skillName)`.

## Writing your own skill

```bash
mkdir -p .flopsy/content/skills/my-skill
$EDITOR .flopsy/content/skills/my-skill/SKILL.md
flopsy gateway restart       # re-scan catalog
```

Good skills are:

- **Narrow.** One purpose per skill. "Research + summarise + email" → three skills the agent composes.
- **Self-contained.** Don't assume context that won't be in the next session's prompt.
- **Under ~2 KB.** Long skills blow the context budget on the turn they're loaded.
- **Grounded in tools.** Name the tools the agent should reach for. Specific is better than abstract.

## Agent-authored skills (review flow)

The agent can write skills it discovers via `skill_manage(create)` mid-conversation. The recommended target for new agent-authored skills is `skills-proposed/` so a human can review before the skill influences future turns:

```bash
flopsy skill proposed list           # what's pending review
flopsy skill proposed show <name>    # read the SKILL.md
flopsy skill proposed accept <name>  # promote to skills/ (active)
flopsy skill proposed reject <name>  # delete
```

`SessionExtractor` (at `/new` or session close) also writes proposals here. It re-reads the closed transcript and proposes a skill whenever a reusable procedure with 3+ steps emerges.

## Installing optional / external skills

```bash
flopsy skill list                              # active
flopsy skill list --optional                   # bundled but not installed
flopsy skill install web-research              # install from optional/
flopsy skill install ./my-skill                # local directory
flopsy skill install ./scratchpad/SKILL.md     # single file
flopsy skill install https://github.com/foo/bar/tree/main/skills/calendar
flopsy skill install https://example.com/skill.md
flopsy skill uninstall <name>                  # active → optional/ (recoverable)
flopsy skill show <name>                       # print body
```

Every non-local install runs through a safety scanner (`tools/skills_guard`-style regex) and prompts before writing into `skills/` unless `--force`.

## Related

- [Agents](./agents.md) — which agents have `skill_manage`
- [Tools](./tools.md) — `skill_manage` operations and shape
- The `skill-creator` bundled skill is a meta-skill that walks you through writing a new one interactively
