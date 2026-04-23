/**
 * Output helpers. Shared across `status`, `run`, `team`, `cron`,
 * `heartbeat`, `webhook` commands.
 *
 * Visual language:
 *   ● Section header   — colored bullet + bold label
 *     dim-label  value — two-column property row, dim label + bright value
 *   ✓ on       good    — green check
 *   ✗ off      bad     — red x
 *   ⚠ warn     warning — yellow warning
 */

import chalk from 'chalk';
import logSymbols from 'log-symbols';
import stripAnsi from 'strip-ansi';
import { supportsHyperlink } from 'supports-hyperlinks';
import { palette, sectionPalette } from './theme';

export interface PrettyOptions {
    /** Force colour on/off; default: auto from stdout.isTTY + NO_COLOR. */
    readonly color?: boolean;
}

export function isColorTty(): boolean {
    if (process.env['NO_COLOR']) return false;
    if (process.env['FORCE_COLOR']) return true;
    return process.stdout.isTTY === true;
}

/**
 * Section header — left-bar accent (`▎`) + bold title. `accent` is a
 * hex string OR a key from the palette ('brand', 'team', …). When
 * omitted, looks up `label` in `sectionPalette` and falls back to
 * brand. One blank line is prepended so sections breathe.
 */
export function section(
    label: string,
    accent?: string,
    opts: PrettyOptions = {},
): string {
    const rich = opts.color ?? isColorTty();

    // Strip trailing " (3/8)" count from the lookup key so counted
    // headers still map to the right palette token.
    const baseName = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const hex = accent?.startsWith('#')
        ? accent
        : palette[(accent as keyof typeof palette) ?? sectionPalette[baseName] ?? 'brand'];

    if (!rich) return `\n▎ ${label}`;
    return `\n${chalk.hex(hex)('▎')} ${chalk.bold(label)}`;
}

export function row(label: string, value: string, opts: PrettyOptions & { labelWidth?: number } = {}): string {
    const rich = opts.color ?? isColorTty();
    const minWidth = opts.labelWidth ?? 14;
    // Guarantee a consistent value-column across all rows in a group:
    // the value always starts at `max(minWidth, longestLabelInCall) + gap`.
    // Callers that want column alignment across multiple rows should pass
    // `labelWidth = max(l.length for l in labels)` so every row pads to
    // the same effective width — otherwise the caller's shorter/longer
    // labels will shift the value column row-to-row.
    const gap = 2;
    const effectiveWidth = Math.max(minWidth, label.length);
    const padCount = effectiveWidth - label.length + gap;
    const labelPad = label + ' '.repeat(padCount);
    return rich ? `  ${chalk.dim(labelPad)}${value}` : `  ${labelPad}${value}`;
}

/**
 * Detail row — same column layout as `row()` but prefixed with a `•`
 * bullet, visually matching the list-item look used by `table()`-based
 * renderers (team/channel/cron/heartbeat/webhook list). Use in `show`
 * / detail views so a single item's fields scan the same way as a
 * multi-item list does.
 *
 *     • role        main
 *     • type        main
 *     • model       ollama:glm-4.6:cloud
 */
export function detail(label: string, value: string, opts: PrettyOptions & { labelWidth?: number } = {}): string {
    const rich = opts.color ?? isColorTty();
    const minWidth = opts.labelWidth ?? 12;
    const gap = 2;
    const effectiveWidth = Math.max(minWidth, label.length);
    const padCount = effectiveWidth - label.length + gap;
    const labelPad = label + ' '.repeat(padCount);
    const bullet = rich ? chalk.dim('•') : '•';
    return rich
        ? `  ${bullet} ${chalk.dim(labelPad)}${value}`
        : `  ${bullet} ${labelPad}${value}`;
}

export function ok(text: string, opts: PrettyOptions = {}): string {
    const rich = opts.color ?? isColorTty();
    // logSymbols handles platform-specific Unicode fallback (Windows console
    // gets `[+]` instead of `✔` when the encoding doesn't cooperate).
    return rich ? `${logSymbols.success} ${chalk.green(text)}` : `${logSymbols.success} ${text}`;
}
export function bad(text: string, opts: PrettyOptions = {}): string {
    const rich = opts.color ?? isColorTty();
    return rich ? `${logSymbols.error} ${chalk.red(text)}` : `${logSymbols.error} ${text}`;
}
export function warn(text: string, opts: PrettyOptions = {}): string {
    const rich = opts.color ?? isColorTty();
    return rich ? `${logSymbols.warning} ${chalk.yellow(text)}` : `${logSymbols.warning} ${text}`;
}
export function info(text: string, opts: PrettyOptions = {}): string {
    const rich = opts.color ?? isColorTty();
    return rich ? `${logSymbols.info} ${chalk.cyan(text)}` : `${logSymbols.info} ${text}`;
}

/**
 * Extended state palette — beyond binary on/off. Each state pairs a
 * single-column glyph with a semantic colour from the theme, so the
 * reader can scan a dense list and get state at a glance.
 *
 *   working  ⟳  a task is currently in-flight (busy + nominal)
 *   queued   ◆  queued / scheduled but not started yet
 *   held     ⏸  paused awaiting input (approval / question)
 *   stalled  ⧬  partially failing / degraded / will retry
 *
 * Use these for anything richer than "enabled/disabled" — e.g. an agent
 * table that may need to distinguish idle, working, and held.
 */
type ExtendedState = 'working' | 'queued' | 'held' | 'stalled';

export function state(kind: ExtendedState, text: string, opts: PrettyOptions = {}): string {
    const rich = opts.color ?? isColorTty();
    const map: Record<ExtendedState, { icon: string; paint: (s: string) => string }> = {
        working: { icon: '⟳', paint: chalk.cyan },
        queued: { icon: '◆', paint: chalk.blueBright },
        held: { icon: '⏸', paint: chalk.yellow },
        stalled: { icon: '⧬', paint: chalk.magenta },
    };
    const entry = map[kind];
    return rich ? `${entry.paint(entry.icon)} ${entry.paint(text)}` : `${entry.icon} ${text}`;
}

/**
 * Clickable terminal hyperlink via the OSC 8 escape sequence. Emitted
 * only when the terminal advertises support (iTerm2, Kitty, WezTerm,
 * modern Gnome Terminal, etc.) — otherwise we fall back to the plain
 * label + URL so no garbage bytes leak into dumb terminals.
 *
 * Usage:  `link('/Users/me/.flopsy/harness/state.db')`
 *         `link('https://console.cloud.google.com/...', 'Google Cloud')`
 */
export function link(url: string, label?: string): string {
    const display = label ?? url;
    if (!isColorTty() || !supportsHyperlink(process.stdout)) return display;
    // OSC 8 ; params ; URL ST ... OSC 8 ; ; ST — see
    // https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda
    const OSC = '\u001B]';
    const ST = '\u001B\\';
    return `${OSC}8;;${url}${ST}${display}${OSC}8;;${ST}`;
}
export function dim(text: string, opts: PrettyOptions = {}): string {
    const rich = opts.color ?? isColorTty();
    return rich ? chalk.dim(text) : text;
}
export function accent(text: string, hex = '#9B59B6', opts: PrettyOptions = {}): string {
    const rich = opts.color ?? isColorTty();
    return rich ? chalk.hex(hex)(text) : text;
}

/**
 * Render an N-column table with per-column alignment. Accepts any row
 * shape `readonly string[]`; all rows must have the same length. ANSI
 * styling is preserved; visible width is computed via `strip-ansi` so
 * colored values don't misalign.
 *
 * Example:
 *   table([
 *     ['gandalf', ok('enabled'), 'main',   chalk.dim('ollama:glm-4.6')],
 *     ['gimli',   ok('enabled'), 'worker', chalk.dim('ollama:gemma:4b')],
 *   ])
 *   =>
 *     gandalf  ✔ enabled  main    ollama:glm-4.6
 *     gimli    ✔ enabled  worker  ollama:gemma:4b
 */
export function table(
    rows: ReadonlyArray<ReadonlyArray<string>>,
    opts: { align?: ReadonlyArray<'left' | 'right' | 'center'> } = {},
): string {
    if (rows.length === 0) return '';
    const cols = rows[0].length;
    const align = opts.align;
    // Per-column max visible width.
    const widths: number[] = new Array(cols).fill(0);
    for (const r of rows) {
        for (let c = 0; c < cols; c++) {
            const w = stripAnsi(r[c] ?? '').length;
            if (w > widths[c]) widths[c] = w;
        }
    }
    return rows
        .map((r) =>
            r
                .map((cell, c) => {
                    const v = cell ?? '';
                    // Last column: no trailing pad unless centered/right-aligned
                    // (which need the pad to position the value correctly).
                    const a = align?.[c] ?? 'left';
                    if (c === cols - 1 && a === 'left') return v;
                    const pad = widths[c] - stripAnsi(v).length;
                    if (a === 'right') return ' '.repeat(pad) + v;
                    if (a === 'center') {
                        const l = Math.floor(pad / 2);
                        const rgt = pad - l;
                        return ' '.repeat(l) + v + ' '.repeat(rgt);
                    }
                    return v + ' '.repeat(pad);
                })
                .join('  '),
        )
        .map((line) => `  ${line}`)
        .join('\n');
}

