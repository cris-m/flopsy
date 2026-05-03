/**
 * Each `<workspace>/skills/<name>/SKILL.md` becomes `/<name>`. Handlers
 * forward a bracketed instruction to the agent (which has filesystem
 * access to /skills); the gateway never runs the skill itself.
 * Discovery is one-shot at boot — restart to pick up new skills.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import type { CommandDef } from './types';

const SKILL_NAME_RE = /^[a-z][a-z0-9_-]*$/;

const MAX_SKILLS = 100;

interface SkillMeta {
    readonly name: string;
    readonly description: string;
}

export function buildSkillCommands(skillsRoot: string): CommandDef[] {
    if (!existsSync(skillsRoot)) return [];

    let entries: string[];
    try {
        entries = readdirSync(skillsRoot);
    } catch {
        return [];
    }

    const skills: SkillMeta[] = [];
    for (const entry of entries) {
        if (skills.length >= MAX_SKILLS) break;
        if (!SKILL_NAME_RE.test(entry)) continue;
        const dir = join(skillsRoot, entry);
        let stat;
        try {
            stat = statSync(dir);
        } catch {
            continue;
        }
        if (!stat.isDirectory()) continue;

        const skillPath = join(dir, 'SKILL.md');
        if (!existsSync(skillPath)) continue;

        const description =
            readSkillDescription(skillPath) ?? `Apply the ${entry} skill.`;
        skills.push({ name: entry, description });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return skills.map((s) => buildCommand(s));
}

function buildCommand(skill: SkillMeta): CommandDef {
    return {
        name: skill.name,
        description: skill.description,
        handler: async (ctx) => {
            const args = ctx.rawArgs.trim();
            if (args.length === 0) {
                return {
                    text: `Loading the \`${skill.name}\` skill. What would you like me to apply it to?`,
                    forwardToAgent:
                        `[The user invoked /${skill.name} with no payload. ` +
                        `Read /skills/${skill.name}/SKILL.md first, then ask ONE clarifying ` +
                        `question grounded in what that skill does so they know what input to give.]`,
                };
            }
            return {
                text: `Applying \`${skill.name}\` skill...`,
                forwardToAgent:
                    `[The user invoked /${skill.name}. Read /skills/${skill.name}/SKILL.md ` +
                    `if you don't already remember it, then apply that skill to the input below. ` +
                    `Stay in the skill's voice and structure.]\n\n${args}`,
            };
        },
    };
}

function readSkillDescription(skillPath: string): string | null {
    let raw: string;
    try {
        raw = readFileSync(skillPath, 'utf-8');
    } catch {
        return null;
    }
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;
    let parsed: unknown;
    try {
        parsed = yaml.load(match[1]!);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const desc = (parsed as Record<string, unknown>)['description'];
    if (typeof desc !== 'string' || desc.trim().length === 0) return null;
    const trimmed = desc.trim();
    return trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed;
}
