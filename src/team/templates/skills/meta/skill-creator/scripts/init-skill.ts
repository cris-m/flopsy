#!/usr/bin/env npx tsx
/**
 * Skill Initializer - Creates a new skill from template
 *
 * Usage:
 *   npx tsx init-skill.ts <skill-name> [--path <path>]
 *
 * Examples:
 *   npx tsx init-skill.ts my-new-skill
 *   npx tsx init-skill.ts data-analyzer --path /custom/location
 */

import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';

const DEFAULT_SKILLS_PATH = 'packages/agent/skills';

const SKILL_TEMPLATE = `---
name: {{skill_name}}
description: "[TODO: What the skill does and when to use it. Include: (1) primary purpose, (2) trigger scenarios, (3) example phrases.]"
---

# {{skill_title}}

[TODO: One-line description of what this skill enables]

## Quick Start

[TODO: Most common use case or basic workflow]

## Tools

| Tool | Purpose |
|------|---------|
| \`tool_name\` | [TODO: What it does] |

## Workflow

[TODO: Step-by-step process or decision tree]

## Guidelines

- [TODO: Key rules and best practices]

## Resources

For detailed documentation, see:
- [reference/api.md](reference/api.md) — API reference
`;

const REFERENCE_TEMPLATE = `# {{skill_title}} Reference

## API Reference

[TODO: Detailed API documentation]

## Examples

[TODO: Code examples and patterns]

## Schemas

[TODO: Data structures and types]
`;

function toTitleCase(skillName: string): string {
    return skillName
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function validateName(name: string): { valid: boolean; error?: string } {
    if (!name) {
        return { valid: false, error: 'Name cannot be empty' };
    }

    if (!/^[a-z0-9-]+$/.test(name)) {
        return {
            valid: false,
            error: `Name '${name}' must be hyphen-case (lowercase letters, digits, hyphens only)`,
        };
    }

    if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
        return {
            valid: false,
            error: `Name '${name}' cannot start/end with hyphen or have consecutive hyphens`,
        };
    }

    if (name.length > 64) {
        return { valid: false, error: `Name too long (${name.length} chars). Maximum is 64.` };
    }

    return { valid: true };
}

async function initSkill(skillName: string, basePath: string): Promise<boolean> {
    const validation = validateName(skillName);
    if (!validation.valid) {
        console.error(`❌ ${validation.error}`);
        return false;
    }

    const skillDir = resolve(basePath, skillName);

    if (existsSync(skillDir)) {
        console.error(`❌ Skill directory already exists: ${skillDir}`);
        return false;
    }

    try {
        await mkdir(skillDir, { recursive: true });
        await mkdir(join(skillDir, 'reference'), { recursive: true });
        console.log(`✅ Created: ${skillDir}`);

        const skillTitle = toTitleCase(skillName);
        const skillContent = SKILL_TEMPLATE.replace(/\{\{skill_name\}\}/g, skillName).replace(
            /\{\{skill_title\}\}/g,
            skillTitle,
        );

        await writeFile(join(skillDir, 'SKILL.md'), skillContent);
        console.log('✅ Created: SKILL.md');

        const refContent = REFERENCE_TEMPLATE.replace(/\{\{skill_title\}\}/g, skillTitle);
        await writeFile(join(skillDir, 'reference', 'api.md'), refContent);
        console.log('✅ Created: reference/api.md');

        console.log(`\n✅ Skill '${skillName}' initialized at ${skillDir}`);
        console.log('\nNext steps:');
        console.log('1. Edit SKILL.md — complete the TODO items');
        console.log('2. Update the description for proper triggering');
        console.log('3. Add reference docs if needed');
        console.log('4. Run validate-skill.ts to check structure');

        return true;
    } catch (error) {
        console.error(`❌ Error: ${error}`);
        return false;
    }
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length < 1) {
        console.log(`
Skill Initializer - Creates a new skill from template

Usage:
  npx tsx init-skill.ts <skill-name> [--path <path>]

Examples:
  npx tsx init-skill.ts my-new-skill
  npx tsx init-skill.ts data-analyzer --path /custom/location
`);
        process.exit(1);
    }

    const skillName = args[0];
    if (!skillName) {
        console.error('Error: skill name is required');
        process.exit(1);
    }

    let basePath = DEFAULT_SKILLS_PATH;

    const pathIndex = args.indexOf('--path');
    const customPath = args[pathIndex + 1];
    if (pathIndex !== -1 && customPath) {
        basePath = customPath;
    }

    console.log('Initializing skill:', skillName);
    console.log('Location:', basePath, '\n');

    const success = await initSkill(skillName, basePath);
    process.exit(success ? 0 : 1);
}

main();
