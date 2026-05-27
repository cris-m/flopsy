import type { CommandDef } from '@gateway/commands/types';
import type { DiscordSlashCommand } from './types';

const DISCORD_MAX_COMMANDS = 100;
const DISCORD_NAME_MAX = 32;
const DISCORD_DESC_MAX = 100;

export function sanitizeDiscordCommandName(name: string): string | null {
    const s = name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, DISCORD_NAME_MAX);
    return /^[a-z0-9_-]{1,32}$/.test(s) ? s : null;
}

function oneLineDescription(raw: string): string {
    return raw
        .replace(/`/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, DISCORD_DESC_MAX);
}

export function buildDiscordCommands(
    registry: readonly CommandDef[],
    configCommands: readonly DiscordSlashCommand[] = [],
): DiscordSlashCommand[] {
    const out: DiscordSlashCommand[] = [];
    const seen = new Set<string>();
    const push = (rawName: string, rawDesc: string): void => {
        if (out.length >= DISCORD_MAX_COMMANDS) return;
        const name = sanitizeDiscordCommandName(rawName);
        if (!name || seen.has(name)) return;
        seen.add(name);
        out.push({ name, description: oneLineDescription(rawDesc) || name });
    };
    for (const c of configCommands) push(c.name, c.description);
    for (const d of registry) push(d.name, d.description);
    return out;
}
