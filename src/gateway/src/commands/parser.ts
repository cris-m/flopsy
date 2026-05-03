export interface ParsedCommand {
    readonly name: string;
    readonly args: string[];
    readonly rawArgs: string;
}

// Telegram's `/cmd@botname` suffix.
const BOT_SUFFIX = /@[A-Za-z0-9_]+$/;

export function parseCommand(text: string): ParsedCommand | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('/')) return null;

    const body = trimmed.slice(1);
    if (body.length === 0) return null;

    const firstSpace = body.search(/\s/);
    const rawName = firstSpace === -1 ? body : body.slice(0, firstSpace);
    const rest = firstSpace === -1 ? '' : body.slice(firstSpace + 1);

    if (rawName.length === 0) return null;

    const name = rawName.replace(BOT_SUFFIX, '').toLowerCase();
    if (name.length === 0) return null;

    // Restrict to a-z 0-9 _ - so "/hello!" flows through to the agent.
    if (!/^[a-z0-9_-]+$/.test(name)) return null;

    const rawArgs = rest.trimStart();
    const args = rawArgs.length === 0 ? [] : rawArgs.split(/\s+/);

    return { name, args, rawArgs };
}
