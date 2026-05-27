/**
 * Tool-call display helpers.
 *
 * Renders Claude Code-style tool indicators:
 *   ⏺ ToolName(args)   — while running (white)
 *   ⏺ ToolName(args)   — on done (green) / error (red)
 *   ⎿  result lines     — dim output below
 *   ⎿  (1.2s)           — duration trailer
 */

import chalk from 'chalk';
import { palette } from '../theme';
import { wrapVisible } from './text-utils';

/**
 * Snake_case / kebab-case → Title Case for displayed tool name.
 * web_search → WebSearch, delegate_task → DelegateTask.
 */
export function formatToolName(raw: string): string {
    if (!raw) return raw;
    if (/^[A-Z]/.test(raw) && !raw.includes('_') && !raw.includes('-')) return raw;
    return raw
        .split(/[_-]/)
        .filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join('');
}

/**
 * Pick the most informative argument value for a one-line preview.
 * Order: file_path → url → query → first string field.
 */
export function argPreview(args: string): string {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(args) as Record<string, unknown>; }
    catch { return args.slice(0, 50); }

    const entries = Object.entries(obj);
    if (entries.length === 0) return '';

    const KEY_PRIORITY = ['file_path', 'path', 'url', 'href', 'query', 'q', 'text', 'prompt', 'message', 'task', 'name'];
    const stringEntries = entries.filter(([, v]) => typeof v === 'string') as Array<[string, string]>;

    let chosen: [string, string] | undefined;
    for (const key of KEY_PRIORITY) {
        const hit = stringEntries.find(([k]) => k === key);
        if (hit) { chosen = hit; break; }
    }
    if (!chosen) chosen = stringEntries[0];

    const MAX_VAL = 50;
    if (chosen) {
        const [k, raw] = chosen;
        const flat = raw.replace(/\s+/g, ' ').trim();
        const val = flat.length > MAX_VAL ? flat.slice(0, MAX_VAL - 1) + '…' : flat;
        if (k === 'file_path' || k === 'path' || k === 'url' || k === 'href') return val;
        return `${k}: ${val}`;
    }
    return entries.slice(0, 3).map(([k]) => k).join(', ');
}

/** Build the running tool line (white ⏺). */
export function buildToolStartLine(name: string, args?: string): string {
    const display = formatToolName(name);
    const preview = args ? argPreview(args) : '';
    return preview
        ? `  ${chalk.white('⏺')} ${chalk.bold(display)}${chalk.hex(palette.muted)('(' + preview + ')')}`
        : `  ${chalk.white('⏺')} ${chalk.bold(display)}`;
}

/** Build the done tool line (green ⏺ on success, red on error). */
export function buildToolDoneLine(name: string, args: string | undefined, isError: boolean): string {
    const display = formatToolName(name);
    const dotColor = isError ? chalk.red('⏺') : chalk.hex(palette.success)('⏺');
    const dim = chalk.hex(palette.muted);
    const preview = args ? argPreview(args) : '';
    return preview
        ? `  ${dotColor} ${chalk.bold(display)}${dim('(' + preview + ')')}`
        : `  ${dotColor} ${chalk.bold(display)}`;
}

/** Build duration trailer line. */
export function buildToolDurationLine(durationMs: number): string {
    const dur = durationMs >= 1000
        ? `${(durationMs / 1000).toFixed(1)}s`
        : `${durationMs}ms`;
    const dim = chalk.hex(palette.muted);
    return `     ${dim('⎿  ' + dim(`(${dur})`))}`;
}

/**
 * Format tool result for display below the call line — Claude Code's
 * `⎿  result` pattern. Multi-line, capped at MAX_LINES.
 */
export function formatToolResultLines(result: string, termWidth: number, isError: boolean, expanded = false): string[] {
    const dim = chalk.hex(palette.muted);
    const errClr = chalk.red;
    const trimmed = result.trim();
    if (!trimmed) return [];

    const innerW = Math.max(40, termWidth - 8);
    // Collapsed: cap at 6 lines with a "ctrl+o to expand" hint. Expanded
    // (Ctrl+O): show everything, still capped generously to avoid runaway.
    const MAX_LINES = expanded ? 200 : 6;
    const rawLines = trimmed.split('\n');

    const out: string[] = [];
    let used = 0;
    for (let li = 0; li < rawLines.length; li++) {
        if (used >= MAX_LINES) {
            const remaining = rawLines.length - li;
            const hint = expanded ? '' : ' · ctrl+o to expand';
            out.push(`     ${dim('⎿  ')}${dim(`… +${remaining} more line${remaining !== 1 ? 's' : ''}${hint}`)}`);
            break;
        }
        const wrapped = wrapVisible(rawLines[li]!, innerW);
        for (let wi = 0; wi < wrapped.length; wi++) {
            if (used >= MAX_LINES) break;
            const isFirst = (li === 0 && wi === 0);
            const prefix = isFirst ? dim('⎿  ') : dim('   ');
            const body = isError ? errClr(wrapped[wi]!) : dim(wrapped[wi]!);
            out.push(`     ${prefix}${body}`);
            used++;
        }
    }
    return out;
}

/**
 * Detect error result from text heuristic. Anchored at the start of the trimmed
 * result so legitimate output containing the word "error" mid-text doesn't
 * trigger false positives. Patterns chosen to match what our tool-bridge,
 * bash-tool, runtime-stubs, and common runtimes actually emit on failure.
 */
export function isToolError(result: string | undefined): boolean {
    if (!result) return false;
    const head = result.trimStart();
    return /^(?:(?:error|exception|traceback|failed?)\b|✗|❌)/i.test(head)
        || /^\[(?:exit code|blocked|unsupported|bridge unreachable|error|timeout|security violation|exception)\b/i.test(head)
        || /^Tool ['"][^'"]+['"] failed/i.test(head)
        || /^(?:ENOENT|EACCES|EPERM|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH)\b/i.test(head)
        || /^(?:ToolError|HTTPError|URLError|FileNotFoundError|PermissionError|ConnectionError)\b/.test(head)
        || /^HTTP\s+[4-5]\d\d\b/i.test(head);
}