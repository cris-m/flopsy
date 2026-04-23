/**
 * Slash-command parser — turns raw message text into a `{name, args, rawArgs}`
 * triple (or null when the text isn't a command).
 *
 * Recognizes:
 *   "/status"                   → { name: 'status', args: [], rawArgs: '' }
 *   "/status foo bar"           → { name: 'status', args: ['foo', 'bar'], rawArgs: 'foo bar' }
 *   "/status  leading  spaces"  → { name: 'status', args: ['leading', 'spaces'], rawArgs: 'leading  spaces' }
 *   "/status@flopsybot"         → { name: 'status', ... }  (Telegram-style bot suffix)
 *   "  /status"                 → { name: 'status', ... }  (lead whitespace tolerated)
 *
 * Does NOT recognize:
 *   "hello /status"             → null  (command must be first non-whitespace token)
 *   "/"                         → null  (empty name)
 *   "/ status"                  → null  (space between / and name)
 */

export interface ParsedCommand {
    readonly name: string;      // lowercased, no "/"
    readonly args: string[];    // whitespace-split arguments
    readonly rawArgs: string;   // everything after the command name, leading whitespace trimmed
}

// Telegram's `/cmd@botname` style — bot username suffix should be stripped.
const BOT_SUFFIX = /@[A-Za-z0-9_]+$/;

export function parseCommand(text: string): ParsedCommand | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('/')) return null;

    // Strip the leading slash, then split into first-word + rest on whitespace.
    const body = trimmed.slice(1);
    if (body.length === 0) return null;

    const firstSpace = body.search(/\s/);
    const rawName = firstSpace === -1 ? body : body.slice(0, firstSpace);
    const rest = firstSpace === -1 ? '' : body.slice(firstSpace + 1);

    // Empty name ("/ status") is invalid.
    if (rawName.length === 0) return null;

    // Strip Telegram bot suffix and lowercase for case-insensitive matching.
    const name = rawName.replace(BOT_SUFFIX, '').toLowerCase();
    if (name.length === 0) return null;

    // Command names are allowed to contain a-z, 0-9, _ and - only.
    // Anything else (e.g. "/hello!") treated as not-a-command so it flows
    // through to the agent.
    if (!/^[a-z0-9_-]+$/.test(name)) return null;

    const rawArgs = rest.trimStart();
    const args = rawArgs.length === 0 ? [] : rawArgs.split(/\s+/);

    return { name, args, rawArgs };
}
