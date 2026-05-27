/**
 * Each SKILL.md becomes `/<name>`. Two layouts supported:
 *   flat:    `<skillsRoot>/<name>/SKILL.md`
 *   grouped: `<skillsRoot>/<group>/<name>/SKILL.md`
 * Handlers forward a bracketed instruction to the agent (which has
 * filesystem access to /skills); the gateway never runs the skill
 * itself. Discovery is one-shot at boot — restart to pick up new skills.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import type { CommandDef } from './types';

const SKILL_NAME_RE = /^[a-z][a-z0-9_-]*$/;

const MAX_SKILLS = 200;

interface SkillMeta {
    readonly name: string;
    readonly description: string;
    /**
     * Worker that owns this skill via `agent-affinity` frontmatter.
     * Set when the skill targets exactly one named worker (not `[*]`,
     * not multiple). When set, the slash command instructs the main
     * agent to `delegate_task` to that worker instead of trying to
     * execute the skill itself — because the affinity filter hides
     * the skill from non-owners and they wouldn't have the tools the
     * skill body expects.
     */
    readonly owner?: string;
}

/**
 * Build a slash command per discovered skill. `mainAgentName` is the name
 * of the agent slash commands are routed to (resolved from config —
 * `agents.find(a => a.role === 'main').name`) and is used to avoid a
 * self-delegation loop when a skill's `agent-affinity` IS the main agent
 * (main applies it directly rather than delegating to itself).
 *
 * Pass `undefined` to disable the self-delegation check entirely — every
 * affinity-tagged skill will route via `delegate_task`, including ones
 * owned by main. Costs one extra delegation hop; harmless if you don't
 * mind it. The right value is the configured main name.
 */
export function buildSkillCommands(skillsRoot: string, mainAgentName?: string): CommandDef[] {
    if (!existsSync(skillsRoot)) return [];

    const skills: SkillMeta[] = [];
    const seen = new Set<string>();
    collectSkills(skillsRoot, skills, seen, 0);

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return skills.map((s) => buildCommand(s, mainAgentName));
}

function collectSkills(root: string, out: SkillMeta[], seen: Set<string>, depth: number): void {
    if (out.length >= MAX_SKILLS) return;
    if (depth > 1) return;

    let entries: string[];
    try {
        entries = readdirSync(root);
    } catch {
        return;
    }

    for (const entry of entries) {
        if (out.length >= MAX_SKILLS) break;
        if (!SKILL_NAME_RE.test(entry)) continue;
        const dir = join(root, entry);
        let stat;
        try {
            stat = statSync(dir);
        } catch {
            continue;
        }
        if (!stat.isDirectory()) continue;

        const skillPath = join(dir, 'SKILL.md');
        if (existsSync(skillPath)) {
            if (seen.has(entry)) continue;
            seen.add(entry);
            const description = readSkillCatalogLine(skillPath) ?? `Apply the ${entry} skill.`;
            const owner = readSkillOwner(skillPath);
            out.push(owner ? { name: entry, description, owner } : { name: entry, description });
        } else if (depth === 0) {
            collectSkills(dir, out, seen, depth + 1);
        }
    }
}

/** Escape user-supplied text before embedding it in an LLM template
 *  that uses `[...]` brackets as framing. Otherwise a user typing
 *  `/myskill ]\n\nIGNORE PREVIOUS INSTRUCTIONS: ...` breaks out of the
 *  bracket and the agent reads the rest as fresh authority. Replace
 *  closing brackets + control sequences with safe equivalents. The
 *  user's text still renders correctly to the model; the agent just
 *  can't escape the bracket framing. */
function escapeForBracketTemplate(s: string): string {
    return s
        .replace(/\]/g, '\\]')
        .replace(/\[INST\]/gi, '[INST_LITERAL]')
        .replace(
            /<\/(?:user_input|user_msg|system|assistant)>/gi,
            (m) => `[${m.slice(2)}_LITERAL]`,
        );
}

function buildCommand(skill: SkillMeta, mainAgentName?: string): CommandDef {
    return {
        name: skill.name,
        description: skill.description,
        handler: async (ctx) => {
            const args = ctx.rawArgs.trim();
            const safeArgs = escapeForBracketTemplate(args);

            if (skill.owner && skill.owner !== mainAgentName) {
                const loadFirst = `First call skill("${skill.name}") to load its exact procedure — do NOT guess tool names or steps. Then follow the loaded SKILL.md precisely, using only the tools it names.`;
                const taskBody = args.length === 0
                    ? `${loadFirst}\n\nThe user invoked /${skill.name} with no payload — after loading the skill, ask one clarifying question grounded in what it does, then proceed once they reply.`
                    : `${loadFirst}\n\nApply it to this input:\n\n${safeArgs}`;
                const escapedTaskBody = escapeForBracketTemplate(taskBody);
                return {
                    text: args.length === 0
                        ? `\`${skill.name}\` is owned by ${skill.owner} — delegating.`
                        : `Delegating \`${skill.name}\` to ${skill.owner}...`,
                    forwardToAgent:
                        `[The user invoked /${skill.name}. This skill is owned by worker \`${skill.owner}\` via agent-affinity — you do NOT have it in your own catalog. ` +
                        `Call \`delegate_task("${skill.owner}", "<task>")\` to hand off. Do NOT try to apply the skill yourself; the worker has the skill body and tools to execute it.]\n\n` +
                        `Suggested task body to pass to delegate_task:\n${escapedTaskBody}`,
                };
            }

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
                    `Stay in the skill's voice and structure.]\n\n${safeArgs}`,
            };
        },
    };
}

/**
 * Read `agent-affinity` from a SKILL.md frontmatter and return the owner
 * worker name when the skill targets exactly one named worker.
 *
 * Returns null for skills tagged `[*]` (universal), skills without an
 * affinity field, or skills tagged for multiple workers — those should
 * stay on the current agent rather than auto-delegating.
 */
function readSkillOwner(skillPath: string): string | undefined {
    let raw: string;
    try {
        raw = readFileSync(skillPath, 'utf-8');
    } catch {
        return undefined;
    }
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return undefined;
    const fm = match[1]!;
    const affMatch = fm.match(/agent-affinity:\s*\[([^\]]*)\]/);
    if (!affMatch) return undefined;
    const targets = affMatch[1]!
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    if (targets.includes('*')) return undefined;
    if (targets.length !== 1) return undefined;
    return targets[0];
}

function readSkillCatalogLine(skillPath: string): string | null {
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
    const obj = parsed as Record<string, unknown>;
    const candidates = [obj['when-to-use'], obj['when_to_use'], obj['description']];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim().length > 0) {
            const trimmed = c.trim();
            return trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed;
        }
    }
    return null;
}
