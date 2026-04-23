---
name: skill-creator
compatibility: Designed for FlopsyBot agent
description: Guide for creating, editing, and validating new skills. Use when you need to add a new capability to the system or update an existing skill file.
---

# Skill Creator

The guide for authoring new skills and maintaining existing ones. Skills are the primary way to extend FlopsyBot's capabilities.

## When to Use This Skill

- You need to add a new capability that does not yet have a skill
- An existing skill needs to be updated or expanded
- You want to validate that a skill file is correctly structured

## How to Run Commands

**Always use the `execute` tool to run commands.** Pass the command string as the `command` parameter. Never tell the user to run commands themselves — you have the `execute` tool.

## Skill File Structure

Every skill lives in its own directory under `packages/agent/skills/{skill-name}/` and must contain a `SKILL.md` file:

```
packages/agent/skills/
  my-skill/
    SKILL.md              <- required: main skill document
    reference/            <- optional: detailed API docs, schemas
      api.md
    scripts/              <- optional: helper scripts
```

### SKILL.md Format

```markdown
---
name: skill-name
compatibility: Designed for FlopsyBot agent
description: "What the skill does and when to use it. Include trigger phrases."
---

# Skill Title

One-line summary of what this skill enables.

## When to Use This Skill
[Trigger conditions and example phrases]

## Tools
[Table of available tools and their purposes]

## Workflow
[Step-by-step process]

## Guidelines
[Rules, best practices, and edge cases]
```

### Frontmatter Rules

The validator (`scripts/validate-skill.ts`) enforces these rules:

- **name** (required): Must be hyphen-case, match the directory name exactly, max 64 characters. Only lowercase letters, digits, and hyphens allowed. No leading/trailing hyphens or consecutive hyphens.
- **description** (required): Plain text, no angle brackets, max 1024 characters. Should describe the primary purpose, when to use it, and example trigger phrases.
- **tags** (optional): Array of strings in `[tag1, tag2]` format.
- **Allowed keys only**: `name`, `description`, `version`, `tags`, `license`, `allowed-tools`, `metadata`. Any other key will fail validation.

### Body Requirements

- Minimum 50 characters of content after the frontmatter
- Maximum 500 lines; move detailed reference material to `reference/` files
- Must include at least a heading and some instructional content

## Creating a New Skill

### Option A: Use the Init Script

```bash
npx tsx packages/agent/skills/skill-creator/scripts/init-skill.ts my-new-skill
```

This creates the directory structure with a template `SKILL.md` and a `reference/api.md` stub. Fill in the TODO items.

### Option B: Manual Creation

1. Create the directory: `packages/agent/skills/my-new-skill/`
2. Write `SKILL.md` following the format above
3. Add `reference/` files if the skill has detailed API documentation
4. Run the validator to check: `npx tsx packages/agent/skills/skill-creator/scripts/validate-skill.ts packages/agent/skills/my-new-skill`

## Validating a Skill

```bash
npx tsx packages/agent/skills/skill-creator/scripts/validate-skill.ts packages/agent/skills/my-skill
```

The validator checks:
- SKILL.md exists and starts with `---`
- Frontmatter has valid `name` and `description`
- `name` matches the directory name
- No unexpected frontmatter keys
- Body is at least 50 characters and under 500 lines

## Writing Effective Descriptions

The description field is critical for skill triggering. A good description includes:
1. **Primary purpose**: What does this skill do?
2. **Trigger scenarios**: When should it be activated?
3. **Example phrases**: What might a user say to trigger it?

Good: `"Send and receive WhatsApp messages. Use when the user wants to message someone via WhatsApp, check WhatsApp conversations, or reply to a WhatsApp message."`

Poor: `"WhatsApp integration."`

## Reference Files

For skills with complex APIs (like google-workspace), move detailed parameter documentation to `reference/` files. The main SKILL.md should have a summary table of tools and link to the reference files for full details.

## Guidelines

- Keep SKILL.md concise and action-oriented; the reader should know what to do within the first few sections
- Use tables for tool listings; they are scannable and consistent
- Always include a "When to Use This Skill" section with concrete trigger phrases
- Test new skills by asking the agent to perform the skill's core action and verifying it works end-to-end
