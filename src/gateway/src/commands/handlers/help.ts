import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { CommandDef } from '../types';
import { getSharedDispatcher } from '../dispatcher';
import { COMMANDS } from '../registry';
import { panel, row, resolveWorkspacePath } from '@flopsy/shared';

function countProposedSkills(): number {
    const dir = join(resolveWorkspacePath('skills'), 'proposed');
    if (!existsSync(dir)) return 0;
    try {
        return readdirSync(dir).filter((name) => {
            try {
                return statSync(join(dir, name)).isDirectory();
            } catch {
                return false;
            }
        }).length;
    } catch {
        return 0;
    }
}

function describeAliases(def: CommandDef): string {
    if (!def.aliases || def.aliases.length === 0) return '';
    return ` (${def.aliases.map((a) => `/${a}`).join(', ')})`;
}

function commandRow(def: CommandDef): string {
    return row(`/${def.name}${describeAliases(def)}`, def.description, 22);
}

export const helpCommand: CommandDef = {
    name: 'help',
    aliases: ['?'],
    description: 'List built-in commands. `/help skills` lists skills, `/help <name>` shows one.',
    handler: async (ctx) => {
        const dispatcher = getSharedDispatcher();
        const allCommands = dispatcher.listCommands();
        const builtinNames = new Set(COMMANDS.map((c) => c.name));
        const builtins = allCommands.filter((c) => builtinNames.has(c.name));
        const skills   = allCommands.filter((c) => !builtinNames.has(c.name));

        const sub = ctx.args[0]?.toLowerCase();

        if (sub === 'skills') {
            return {
                text: panel(
                    [{ title: `skills (${skills.length})`, lines: skills.map(commandRow) }],
                    {
                        header: 'FLOPSY SKILLS',
                        footer:
                            `Use \`/help <name>\` for details. ${skills.length} skills auto-discovered ` +
                            'from your workspace.',
                    },
                ),
            };
        }

        if (sub) {
            const def = dispatcher.resolve(sub);
            if (!def) {
                return { text: `\`/${sub}\` is not a registered command. Try \`/help\`.` };
            }
            const aliasLine = def.aliases?.length ? `aliases  ${def.aliases.map((a) => `/${a}`).join(', ')}` : '';
            const scope     = def.scope ? `scope    ${def.scope}` : '';
            const lines = [
                `name     /${def.name}`,
                aliasLine,
                scope,
                '',
                def.description,
            ].filter(Boolean);
            return { text: panel([{ title: 'details', lines }], { header: `/${def.name}` }) };
        }

        const proposedCount = countProposedSkills();
        const skillsLines = [
            `${skills.length} skills auto-loaded from <workspace>/skills/.`,
            'Use `/help skills` to list them, or `/<name>` to invoke one directly.',
        ];
        if (proposedCount > 0) {
            skillsLines.push(
                `${proposedCount} pending proposal${proposedCount === 1 ? '' : 's'} — \`/skills review\` to look at them.`,
            );
        }
        return {
            text: panel(
                [
                    { title: 'commands', lines: builtins.map(commandRow) },
                    { title: 'skills', lines: skillsLines },
                ],
                {
                    header: 'FLOPSY COMMANDS',
                    footer: 'Slash commands run directly in the gateway — no LLM call, no token cost.',
                },
            ),
        };
    },
};
