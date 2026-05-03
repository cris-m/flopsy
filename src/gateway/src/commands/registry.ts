import type { CommandDef } from './types';
import { statusCommand } from './handlers/status';
import { helpCommand } from './handlers/help';
import { auditCommand } from './handlers/audit';
import { teamCommand } from './handlers/team';
import { tasksCommand } from './handlers/tasks';
import { doctorCommand } from './handlers/doctor';
import { dndCommand } from './handlers/dnd';
import { insightsCommand } from './handlers/insights';
import { branchCommand } from './handlers/branch';
import { newCommand } from './handlers/new';
import { compactCommand } from './handlers/compact';
import { personalityCommand } from './handlers/personality';
import { planCommand } from './handlers/plan';
import { mcpCommand } from './handlers/mcp';
import { skillsCommand } from './handlers/skills';
import { buildSkillCommands } from './skill-commands';

const BUILTIN_COMMANDS: readonly CommandDef[] = [
    newCommand,
    compactCommand,
    branchCommand,
    planCommand,
    mcpCommand,
    statusCommand,
    teamCommand,
    tasksCommand,
    doctorCommand,
    dndCommand,
    personalityCommand,
    insightsCommand,
    auditCommand,
    skillsCommand,
    helpCommand,
];

export const COMMANDS: readonly CommandDef[] = BUILTIN_COMMANDS;

/**
 * Built-ins + auto-discovered skills under `<workspace>/skills/<name>/`.
 * Built-ins win on name collisions.
 */
export function buildAllCommands(skillsRoot: string): readonly CommandDef[] {
    const skillCommands = buildSkillCommands(skillsRoot);
    const builtinNames = new Set<string>(
        BUILTIN_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
    );
    const filteredSkills = skillCommands.filter((s) => !builtinNames.has(s.name));
    return [...BUILTIN_COMMANDS, ...filteredSkills];
}

/** Throws on alias/name collision (development-time bug). */
export function buildLookup(
    commands: readonly CommandDef[] = COMMANDS,
): Map<string, CommandDef> {
    const lookup = new Map<string, CommandDef>();
    for (const def of commands) {
        const keys = [def.name, ...(def.aliases ?? [])];
        for (const key of keys) {
            const lower = key.toLowerCase();
            if (lookup.has(lower)) {
                throw new Error(
                    `command registry: duplicate key "${lower}" — ` +
                        `collision between "${lookup.get(lower)!.name}" and "${def.name}"`,
                );
            }
            lookup.set(lower, def);
        }
    }
    return lookup;
}
