/**
 * Central command registry. Single source of truth consumed by:
 *   - the dispatcher (name/alias → handler)
 *   - the `/help` handler (renders all descriptions)
 *   - future platform-native registration (Discord slash commands, Telegram
 *     BotCommand menus) would read from here too
 *
 * Add a new command: import its definition from `./handlers/*` and append
 * it to COMMANDS below. The command is auto-discoverable via /help on the
 * next restart.
 */

import type { CommandDef } from './types';
import { statusCommand } from './handlers/status';
import { helpCommand } from './handlers/help';
import { auditCommand } from './handlers/audit';

/**
 * All registered slash commands. Order matters only for the /help display —
 * dispatch is keyed by name/alias in a Map.
 */
export const COMMANDS: readonly CommandDef[] = [
    statusCommand,
    auditCommand,
    helpCommand,
];

/**
 * Build a name→def lookup including aliases. Asserts there are no
 * collisions (would be a bug at development time).
 */
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
