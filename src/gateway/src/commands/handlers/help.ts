/**
 * /help — lists every registered command with its description.
 *
 * Reads the dispatcher's registry so nothing is hardcoded. Adding a new
 * command anywhere in the registry makes it appear here automatically.
 */

import type { CommandDef } from '../types';
import { getSharedDispatcher } from '../dispatcher';

export const helpCommand: CommandDef = {
    name: 'help',
    aliases: ['?'],
    description: 'List available slash commands.',
    handler: async () => {
        const dispatcher = getSharedDispatcher();
        const commands = dispatcher.listCommands();

        const lines: string[] = ['*Flopsy commands:*'];
        for (const def of commands) {
            const aliases = def.aliases && def.aliases.length > 0 ? ` (/${def.aliases.join(', /')})` : '';
            lines.push(`  \`/${def.name}\`${aliases} — ${def.description}`);
        }
        lines.push('');
        lines.push('_Slash commands are handled directly by the gateway — fast, deterministic, no LLM call._');

        return { text: lines.join('\n') };
    },
};
