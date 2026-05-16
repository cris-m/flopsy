/**
 * Slash-command hint popup — shown below the input when the user types `/`.
 *
 * Renders a scannable window into matching commands, with ↑↓ navigation
 * and tab/enter to accept.
 */

import chalk from 'chalk';
import { palette } from '../theme';
import { truncateAnsi } from './text-utils';

export interface SlashCmd {
    readonly name: string;
    readonly description: string;
    readonly argHint?: string;
}

export const SLASH_COMMANDS: readonly SlashCmd[] = [
    { name: 'new',         description: 'start a fresh session, keep facts + prefs' },
    { name: 'clear',       description: 'clear the screen (local)' },
    { name: 'compact',     description: 'summarise + compact the current session' },
    { name: 'branch',      description: 'branch to a fresh context window' },
    { name: 'plan',        description: 'plan a task before executing', argHint: '<task description>' },
    { name: 'mcp',         description: 'show MCP server status', argHint: '[reload]' },
    { name: 'status',      description: 'show gateway + team status' },
    { name: 'team',        description: 'show team roster + worker activity' },
    { name: 'tasks',       description: 'list active background tasks' },
    { name: 'doctor',      description: 'quick health verdict' },
    { name: 'dnd',         description: 'toggle do-not-disturb', argHint: '[duration | off]' },
    { name: 'personality', description: 'switch the agent voice', argHint: '[name | reset]' },
    { name: 'insights',    description: 'view learned insights' },
    { name: 'audit',       description: 'static security scan (no LLM)' },
    { name: 'skills',      description: 'review skill proposals', argHint: '[approve | reject] <name>' },
    { name: 'help',        description: 'list commands', argHint: '[command]' },
    { name: 'exit',        description: 'close the chat (local — not sent to the agent)' },
];

/**
 * Find slash commands matching the current input prefix.
 * Empty when input doesn't start with '/' or a space has been typed.
 */
export function getSlashMatches(inputBuf: string): readonly SlashCmd[] {
    if (!inputBuf.startsWith('/')) return [];
    const rest = inputBuf.slice(1);
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx !== -1) return [];
    return SLASH_COMMANDS.filter((cmd) =>
        cmd.name.startsWith(rest.toLowerCase()),
    );
}

/**
 * Render the slash-hint popup. Returns 0..8 lines.
 * @param inputBuf   current input buffer
 * @param activeIdx  highlighted index in the match list
 * @param termWidth  terminal width for truncation
 */
export function renderSlashHints(
    inputBuf: string,
    activeIdx: number,
    termWidth: number,
): string[] {
    if (!inputBuf.startsWith('/')) return [];

    const rest = inputBuf.slice(1);
    const spaceIdx = rest.indexOf(' ');
    const cmdName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);

    // Inline argument hint
    if (spaceIdx !== -1) {
        const exact = SLASH_COMMANDS.find((cmd) => cmd.name === cmdName);
        if (exact?.argHint) {
            const dim = chalk.hex(palette.muted);
            return [`  ${dim(`↳ /${exact.name} ${exact.argHint}`)}`];
        }
        return [];
    }

    const matches = getSlashMatches(inputBuf);
    if (matches.length === 0) return [];

    const safeIdx = activeIdx >= matches.length ? 0 : activeIdx;

    const dim = chalk.hex(palette.muted);
    const blue = chalk.hex(palette.channel);
    const accent = chalk.hex('#D77757');

    const WINDOW = 6;
    const total = matches.length;
    const halfWindow = Math.floor(WINDOW / 2);
    let windowStart = Math.max(0, safeIdx - halfWindow);
    if (windowStart + WINDOW > total) windowStart = Math.max(0, total - WINDOW);
    const windowEnd = Math.min(total, windowStart + WINDOW);
    const visible = matches.slice(windowStart, windowEnd);

    const nameW = Math.max(...visible.map((m) => m.name.length));
    const lines: string[] = [];

    if (windowStart > 0) {
        lines.push(dim(`   ↑ ${windowStart} more`));
    }

    visible.forEach((m, i) => {
        const absIdx = windowStart + i;
        const isActive = absIdx === safeIdx && total > 1;
        const cursor = isActive ? accent('▸') : ' ';
        const namePart = isActive
            ? blue.bold('/' + m.name.padEnd(nameW))
            : blue('/' + m.name.padEnd(nameW));
        const desc = isActive
            ? chalk.white(' ' + m.description)
            : dim(' ' + m.description);
        const raw = ` ${cursor} ${namePart} ${desc}`;
        lines.push(truncateAnsi(raw, termWidth - 1));
    });

    if (windowEnd < total) {
        lines.push(dim(`   ↓ ${total - windowEnd} more`));
    }

    if (total > 1) {
        lines.push(dim('   ↑↓ navigate · tab/enter accept · esc dismiss'));
    }
    return lines;
}