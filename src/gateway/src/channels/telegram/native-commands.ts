import type { CommandDef } from '@gateway/commands/types';

export interface TelegramBotCommand {
    readonly command: string;
    readonly description: string;
}

const TG_MAX_COMMANDS = 100;
const TG_NAME_MAX = 32;
const TG_DESC_MAX = 256;

export function sanitizeTelegramCommandName(name: string): string | null {
    const s = name
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, TG_NAME_MAX);
    return /^[a-z0-9_]{1,32}$/.test(s) ? s : null;
}

function oneLineDescription(raw: string): string {
    return raw
        .replace(/`/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TG_DESC_MAX);
}

export function buildTelegramCommands(defs: readonly CommandDef[]): TelegramBotCommand[] {
    const out: TelegramBotCommand[] = [];
    const seen = new Set<string>();
    for (const def of defs) {
        if (out.length >= TG_MAX_COMMANDS) break;
        const command = sanitizeTelegramCommandName(def.name);
        if (!command || seen.has(command)) continue;
        const description = oneLineDescription(def.description) || command;
        seen.add(command);
        out.push({ command, description });
    }
    return out;
}
