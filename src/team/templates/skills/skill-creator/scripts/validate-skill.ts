#!/usr/bin/env npx tsx
/**
 * Skill Validator - Validates skill structure and frontmatter
 *
 * Usage:
 *   npx tsx validate-skill.ts <skill-directory>
 *
 * Examples:
 *   npx tsx validate-skill.ts packages/agent/skills/my-skill
 *   npx tsx validate-skill.ts ./skills/web-research
 */

import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, basename } from 'path';

const ALLOWED_PROPERTIES = new Set([
    'name',
    'description',
    'version',
    'tags',
    'license',
    'allowed-tools',
    'metadata',
]);

interface ValidationResult {
    valid: boolean;
    message: string;
}

function parseSimpleYaml(text: string): Record<string, string> {
    const result: Record<string, string> = {};

    for (const line of text.split('\n')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0 && !line.trim().startsWith('#')) {
            const key = line.slice(0, colonIndex).trim();
            let value = line.slice(colonIndex + 1).trim();

            // Handle arrays like tags: [a, b, c]
            if (value.startsWith('[') && value.endsWith(']')) {
                value = value.slice(1, -1);
            }

            // Remove quotes
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }

            if (key) {
                result[key] = value;
            }
        }
    }

    return result;
}

async function validateSkill(skillPath: string): Promise<ValidationResult> {
    const skillDir = resolve(skillPath);
    const dirName = basename(skillDir);

    // Check directory exists
    if (!existsSync(skillDir)) {
        return { valid: false, message: `Directory not found: ${skillDir}` };
    }

    const stats = await stat(skillDir);
    if (!stats.isDirectory()) {
        return { valid: false, message: `Not a directory: ${skillDir}` };
    }

    // Check SKILL.md exists
    const skillMdPath = resolve(skillDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
        return { valid: false, message: 'SKILL.md not found' };
    }

    // Read content
    let content: string;
    try {
        content = await readFile(skillMdPath, 'utf-8');
    } catch (error) {
        return { valid: false, message: `Cannot read SKILL.md: ${error}` };
    }

    // Check frontmatter exists
    if (!content.startsWith('---')) {
        return { valid: false, message: 'No YAML frontmatter found (must start with ---)' };
    }

    // Extract frontmatter
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match || !match[1]) {
        return { valid: false, message: 'Invalid frontmatter format (missing closing ---)' };
    }

    const frontmatterText = match[1];
    const frontmatter = parseSimpleYaml(frontmatterText);

    // Check for unexpected properties
    const unexpected = Object.keys(frontmatter).filter((k) => !ALLOWED_PROPERTIES.has(k));
    if (unexpected.length > 0) {
        return { valid: false, message: `Unexpected frontmatter keys: ${unexpected.join(', ')}` };
    }

    // Validate required fields
    if (!frontmatter.name) {
        return { valid: false, message: 'Missing required field: name' };
    }

    if (!frontmatter.description) {
        return { valid: false, message: 'Missing required field: description' };
    }

    // Validate name format
    const name = frontmatter.name.trim();
    if (name) {
        if (!/^[a-z0-9-]+$/.test(name)) {
            return {
                valid: false,
                message: `Name '${name}' must be hyphen-case (lowercase, digits, hyphens)`,
            };
        }

        if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
            return { valid: false, message: `Name '${name}' has invalid hyphen placement` };
        }

        if (name.length > 64) {
            return { valid: false, message: `Name too long (${name.length} chars, max 64)` };
        }

        // Check name matches directory
        if (name !== dirName) {
            return { valid: false, message: `Name '${name}' doesn't match directory '${dirName}'` };
        }
    }

    // Validate description
    const description = frontmatter.description.trim();
    if (description) {
        if (description.includes('<') || description.includes('>')) {
            return { valid: false, message: 'Description cannot contain angle brackets (< or >)' };
        }

        if (description.length > 1024) {
            return {
                valid: false,
                message: `Description too long (${description.length} chars, max 1024)`,
            };
        }
    }

    // Check body has content
    const body = content.slice(match[0].length).trim();
    if (body.length < 50) {
        return { valid: false, message: 'SKILL.md body is too short (need instructions)' };
    }

    // Count lines
    const lineCount = body.split('\n').length;
    if (lineCount > 500) {
        return {
            valid: false,
            message: `SKILL.md body too long (${lineCount} lines, max 500). Move content to reference/ files.`,
        };
    }

    return { valid: true, message: `✅ Skill '${name}' is valid! (${lineCount} lines)` };
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length !== 1) {
        console.log(`
Skill Validator - Validates skill structure and frontmatter

Usage:
  npx tsx validate-skill.ts <skill-directory>

Examples:
  npx tsx validate-skill.ts packages/agent/skills/my-skill
  npx tsx validate-skill.ts ./skills/web-research
`);
        process.exit(1);
    }

    const skillPath = args[0];
    if (!skillPath) {
        console.error('❌ Error: skill path is required');
        process.exit(1);
    }
    console.log(`🔍 Validating: ${skillPath}\n`);

    const result = await validateSkill(skillPath);

    if (result.valid) {
        console.log(result.message);
    } else {
        console.error(`❌ ${result.message}`);
    }

    process.exit(result.valid ? 0 : 1);
}

main();
