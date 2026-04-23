/**
 * Flopsy the rabbit mascot + welcome banner.
 *
 * Two modes:
 *   - `printBanner()`      — boxed two-column splash on `flopsy` with no
 *                             subcommand (mascot + tips side-by-side).
 *   - `formatBannerLine()` — one-liner for `--version` and log headers.
 *
 * All drawing is ANSI-aware: padding and centering use `stripAnsi` to
 * avoid counting escape codes as visible width.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import cliBoxes from 'cli-boxes';
import stripAnsi from 'strip-ansi';
import { workspace } from '@flopsy/shared';
import { palette } from './theme';

/**
 * Grapheme-aware string splitter. Using `Intl.Segmenter` means a string
 * with combining marks or emoji (e.g. '🐰' or 'a\u0301') counts as one
 * visible column, not 2-3 bytes — matches how terminals actually render.
 * Falls back to `Array.from` on runtimes without Intl.Segmenter.
 */
const graphemeSegmenter =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;

function splitGraphemes(value: string): string[] {
    if (!graphemeSegmenter) return Array.from(value);
    try {
        return Array.from(graphemeSegmenter.segment(value), (seg) => seg.segment);
    } catch {
        return Array.from(value);
    }
}

// Small rabbit — kept compact so the panel fits on standard 80-col
// terminals without wrapping.
const RABBIT = `
  (\\(\\
  ( -.-)
 o_(")(")`;

const TAGLINES: readonly string[] = [
    'your personal agent, everywhere you chat',
    'hop-to-it automation for channel-first agents',
    "don't bug the user, channel them",
    'a little rabbit, a lot of tools',
];

export interface BannerOptions {
    readonly version?: string;
    readonly commit?: string;
    /** Force colour on/off; defaults to auto-detect. */
    readonly color?: boolean;
    /** One of TAGLINES (rotated) or explicit string. Omit for random. */
    readonly tagline?: string;
}

function isColorTty(): boolean {
    if (process.env['NO_COLOR']) return false;
    if (process.env['FORCE_COLOR']) return true;
    return process.stdout.isTTY === true;
}

function pickTagline(explicit?: string): string {
    if (explicit !== undefined) return explicit;
    const idx = Math.floor(Math.random() * TAGLINES.length);
    return TAGLINES[idx];
}

function styleTitle(rich: boolean): string {
    const title = 'FlopsyBot';
    return rich ? chalk.bold.hex('#9B59B6')(title) : title;
}

function styleVersion(version: string, commit: string | undefined, rich: boolean): string {
    const base = `v${version}`;
    const full = commit ? `${base} (${commit.slice(0, 7)})` : base;
    return rich ? chalk.dim(full) : full;
}

function styleTagline(tagline: string, rich: boolean): string {
    return rich ? chalk.italic.gray(tagline) : tagline;
}

/**
 * Per-character rabbit tinting. Each glyph family gets a different shade
 * so the mascot has visual depth instead of flat brand colour:
 *   ( ) . -        → outline → brand accent (purple)
 *   "              → whiskers → lavender
 *   o _ \ /        → body fur → muted gray
 */
export function styleRabbit(rich: boolean): string {
    if (!rich) return RABBIT;
    const accent = chalk.hex(palette.brand);
    const bright = chalk.hex('#C39BD3'); // lavender — whiskers
    const muted = chalk.hex(palette.muted);

    const colorChar = (ch: string): string => {
        if (ch === ' ' || ch === '\n') return ch;
        if (ch === '"') return bright(ch);
        if (ch === 'o' || ch === '_' || ch === '\\' || ch === '/') return muted(ch);
        return accent(ch);
    };

    return RABBIT.split('\n')
        .map((line) => splitGraphemes(line).map(colorChar).join(''))
        .join('\n');
}

// --- ANSI-aware layout helpers ---------------------------------------------

function visLen(s: string): number {
    return stripAnsi(s).length;
}

/**
 * Truncate a PLAIN string (no ANSI) to at most `width` visible chars.
 * Adds an ellipsis if it clipped anything. Use this on raw text BEFORE
 * applying chalk — truncating chalked output mid-escape breaks styling.
 */
function truncatePlain(s: string, width: number): string {
    if (s.length <= width) return s;
    if (width <= 1) return s.slice(0, width);
    return s.slice(0, width - 1) + '…';
}

function padRightVisible(s: string, width: number): string {
    const vis = visLen(s);
    if (vis > width) {
        // Defence-in-depth: if anything sneaks past the truncate-at-source
        // path and arrives over-wide, clip the plain form so the box
        // doesn't break. Colour is lost on clipped rows — acceptable
        // trade-off vs. broken alignment.
        return truncatePlain(stripAnsi(s), width);
    }
    return s + ' '.repeat(width - vis);
}

function centerVisible(s: string, width: number): string {
    const vis = visLen(s);
    if (vis > width) return padRightVisible(s, width);
    const remaining = width - vis;
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return ' '.repeat(left) + s + ' '.repeat(right);
}

function tildeHome(p: string): string {
    const home = homedir();
    return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/**
 * Build a list of "recent activity" entries for the welcome panel by
 * reading file mtimes of known state artifacts. Our sessions are packed
 * into SQLite, so we surrogate by showing the mtime of the database
 * files + config.
 *
 * Returns up to `limit` entries, newest first, each shaped as a
 * `<label> — <relative-time>` line. Returns `[]` when nothing exists.
 */
interface ActivityEntry {
    readonly label: string;
    readonly mtimeMs: number;
}

function getRecentActivity(limit = 3): readonly ActivityEntry[] {
    // Delegate to the shared workspace resolver — config-reader already
    // ran dotenv + primeFlopsyHome, so `workspace.root()` returns the
    // same absolute path the gateway sees.
    const flopsyHome = workspace.root();

    // Candidate artifacts — each maps to a human label. Files that don't
    // exist are dropped. Order doesn't matter; sorted by mtime below.
    const candidates: ReadonlyArray<readonly [string, string]> = [
        [join(process.cwd(), 'flopsy.json5'), 'config edited'],
        [join(flopsyHome, 'harness', 'checkpoints.db-wal'), 'turn completed'],
        [join(flopsyHome, 'harness', 'checkpoints.db'), 'checkpoint written'],
        [join(flopsyHome, 'harness', 'state.db'), 'state updated'],
        [join(flopsyHome, 'harness', 'memory.db-wal'), 'memory write'],
        [join(flopsyHome, 'logs', 'gateway.log'), 'gateway log'],
    ];

    const entries: ActivityEntry[] = [];
    for (const [path, label] of candidates) {
        if (!existsSync(path)) continue;
        try {
            const mtime = statSync(path).mtimeMs;
            entries.push({ label, mtimeMs: mtime });
        } catch {
            // permission issue / race — skip silently
        }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries.slice(0, limit);
}

/**
 * Format a millisecond timestamp as "5m ago" / "2h ago" / "3d ago" —
 * short, scannable, no seconds.
 */
function formatRelative(mtimeMs: number): string {
    const diffMs = Date.now() - mtimeMs;
    if (diffMs < 60_000) return 'just now';
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w ago`;
    return `${Math.floor(days / 30)}mo ago`;
}

// --- one-liner (used by --version) -----------------------------------------

export function formatBannerLine(opts: BannerOptions = {}): string {
    const rich = opts.color ?? isColorTty();
    const version = opts.version ?? '0.0.0';
    const tagline = pickTagline(opts.tagline);
    const emoji = rich ? '🐰 ' : '';
    const title = styleTitle(rich);
    const versionStr = styleVersion(version, opts.commit, rich);
    const sep = rich ? chalk.dim(' — ') : ' — ';
    return `${emoji}${title} ${versionStr}${sep}${styleTagline(tagline, rich)}`;
}

// --- main welcome panel ----------------------------------------------------

/**
 * Two-column welcome panel:
 *
 *   ╭─── FlopsyBot v1.0.0 ─────────────────────...─╮
 *   │                        │ Tips for getting started         │
 *   │   Welcome back cris!   │  • `flopsy onboard` to wire...   │
 *   │                        │  • `flopsy doctor` for checks    │
 *   │       (\(\             │ ─────────────────────────        │
 *   │       ( -.-)           │ Status                           │
 *   │      o_(")(")          │ gateway: not running             │
 *   │                        │                                  │
 *   │  a tagline line here   │                                  │
 *   │  ~/path/to/cwd         │                                  │
 *   ╰──────────────────────────────────────────...──╯
 */
/**
 * Should we draw the welcome splash? Suppresses output when:
 *   - stdout is not a TTY (being piped / redirected)
 *   - caller passed `--json` anywhere (machine-readable mode)
 *   - caller passed `--version` / `-V` (handled by commander separately)
 *   - `FLOPSY_NO_BANNER=1` (explicit opt-out for scripts)
 */
function shouldShowBanner(argv: ReadonlyArray<string> = process.argv): boolean {
    if (!process.stdout.isTTY) return false;
    if (process.env['FLOPSY_NO_BANNER']) return false;
    for (const a of argv) {
        if (a === '--json' || a.startsWith('--json=')) return false;
        if (a === '--version' || a === '-V') return false;
    }
    return true;
}

/**
 * Wipe the visible screen + scrollback and park the cursor at the top
 * before drawing the splash, so the welcome panel always appears at a
 * predictable position rather than being pushed halfway down the
 * terminal by whatever scrollback was there.
 *
 *   \x1b[3J — clear scrollback buffer (xterm / iTerm / most modern terms)
 *   \x1b[2J — clear visible area
 *   \x1b[H  — move cursor to row 1, col 1
 *
 * Opt-out: set `FLOPSY_NO_CLEAR=1` (useful in CI logs or screen-recorded
 * demos where wiping prior context would be destructive).
 */
function clearScreen(): void {
    if (!process.stdout.isTTY) return;
    if (process.env['FLOPSY_NO_CLEAR']) return;
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
}

export function printBanner(opts: BannerOptions = {}): void {
    if (!shouldShowBanner()) return;
    clearScreen();

    const rich = opts.color ?? isColorTty();
    const version = opts.version ?? '0.0.0';
    const tagline = pickTagline(opts.tagline);

    // Width: use terminal width, cap at 110. Below 72, fall back to the
    // simple stacked layout (mascot above info) since the split panel
    // gets cramped.
    const termCols = process.stdout.columns ?? 100;
    if (termCols < 72) return printCompactBanner(opts);

    const boxWidth = Math.min(termCols, 110);
    const box = cliBoxes.round;
    const paintBorder = (s: string): string => (rich ? chalk.hex(palette.brand)(s) : s);
    const borderDim = (s: string): string => (rich ? chalk.dim(s) : s);

    const user = safeUsername();
    const cwd = tildeHome(process.cwd());

    // Layout maths. Two columns separated by " │ " (3 visible chars).
    // We add 2 spaces of inner margin after the left border (" L │ R "),
    // so the actual content widths are narrower than the column slots.
    // Reserved columns in a row: │ (1) + space (1) + L + space (1) + │ (1)
    // + space (1) + R + space (1) + │ (1) = 7 overhead + L + R.
    const innerWidth = boxWidth - 2; // between the outer │ │
    const leftColWidth = Math.max(28, Math.floor(innerWidth * 0.42));
    // Row overhead inside innerWidth: " " + L + " " + "│" + " " + R + " " = 5
    const rightColWidth = innerWidth - leftColWidth - 5;

    // --- left column -------------------------------------------------------

    const rabbitRaw = styleRabbit(rich)
        .split('\n')
        .filter((l) => l.length > 0);

    // Truncate plain text at source — applying chalk AFTER means we never
    // have to deal with slicing inside ANSI escape sequences.
    const welcomeText = truncatePlain(`Welcome back ${user}!`, leftColWidth);
    const welcome = rich ? chalk.bold(welcomeText) : welcomeText;
    const taglineTrimmed = truncatePlain(tagline, leftColWidth);
    const cwdTrimmed = truncatePlain(cwd, leftColWidth);

    const leftLines: string[] = [
        '',
        centerVisible(welcome, leftColWidth),
        '',
        ...rabbitRaw.map((r) => centerVisible(r, leftColWidth)),
        '',
        centerVisible(
            `${styleTitle(rich)} ${styleVersion(version, opts.commit, rich)}`,
            leftColWidth,
        ),
        centerVisible(styleTagline(taglineTrimmed, rich), leftColWidth),
        '',
        centerVisible(rich ? chalk.dim(cwdTrimmed) : cwdTrimmed, leftColWidth),
        '',
    ];

    // --- right column ------------------------------------------------------

    const h = (s: string): string => (rich ? chalk.bold(s) : s);
    const dim = (s: string): string => (rich ? chalk.dim(s) : s);
    const dash = borderDim('─'.repeat(Math.max(6, rightColWidth)));

    // Keep tips short enough to fit without clipping.
    // Each tip's plain form must be ≤ rightColWidth.
    const tips: ReadonlyArray<readonly [string, string]> = [
        ['flopsy onboard', 'enable channels + auth'],
        ['flopsy doctor', 'run health checks'],
        ['flopsy status', 'gateway snapshot'],
        ['flopsy --help', 'all commands'],
    ];
    const renderTip = (cmd: string, what: string): string => {
        const line = ` • ${cmd} ${dim('—')} ${what}`;
        const plain = stripAnsi(line);
        return plain.length <= rightColWidth ? line : truncatePlain(plain, rightColWidth);
    };

    // Recent activity — read file mtimes of our state artifacts and
    // render up to 3 `<label> — <rel time>` lines. Empty state falls
    // back to the old "No recent activity" placeholder.
    const activity = getRecentActivity(3);
    const activityLines = activity.length === 0
        ? [dim(truncatePlain('No recent activity', rightColWidth))]
        : activity.map(({ label, mtimeMs }) => {
            const rel = formatRelative(mtimeMs);
            const raw = ` • ${label} ${dim('—')} ${rel}`;
            const visible = stripAnsi(raw);
            return visible.length <= rightColWidth
                ? raw
                : truncatePlain(visible, rightColWidth);
        });

    const rightLines: string[] = [
        '',
        h('Tips for getting started'),
        ...tips.map(([cmd, what]) => renderTip(cmd, what)),
        '',
        dash,
        '',
        h('Recent activity'),
        ...activityLines,
        '',
    ];

    // --- assemble box ------------------------------------------------------

    // Top bar with embedded title: ╭── FlopsyBot v1.0.0 ────...─╮
    const titleInline = ` ${styleTitle(rich)} ${styleVersion(version, opts.commit, rich)} `;
    const titleVis = visLen(titleInline);
    const dashBudget = boxWidth - 2 - titleVis; // 2 corners
    const leftDashes = 3;
    const rightDashes = Math.max(1, dashBudget - leftDashes);
    const topBar =
        paintBorder(box.topLeft) +
        paintBorder(box.top.repeat(leftDashes)) +
        titleInline +
        paintBorder(box.top.repeat(rightDashes)) +
        paintBorder(box.topRight);

    const bottomBar =
        paintBorder(box.bottomLeft) +
        paintBorder(box.bottom.repeat(innerWidth)) +
        paintBorder(box.bottomRight);

    const rows = Math.max(leftLines.length, rightLines.length);
    const out: string[] = [topBar];
    for (let i = 0; i < rows; i++) {
        const L = padRightVisible(leftLines[i] ?? '', leftColWidth);
        const R = padRightVisible(rightLines[i] ?? '', rightColWidth);
        // Row layout: │<sp>L<sp>│<sp>R<sp>│  — 5 overhead chars between borders.
        out.push(
            `${paintBorder(box.left)} ${L} ${paintBorder(box.left)} ${R} ${paintBorder(box.right)}`,
        );
    }
    out.push(bottomBar);

    console.log(out.join('\n'));
}

/**
 * Stacked fallback for narrow terminals (<72 cols). Simpler than the
 * panel but still ANSI-aware.
 */
function printCompactBanner(opts: BannerOptions): void {
    const rich = opts.color ?? isColorTty();
    const version = opts.version ?? '0.0.0';
    const tagline = pickTagline(opts.tagline);
    const rabbit = styleRabbit(rich)
        .split('\n')
        .filter((l) => l.length > 0);
    const info = [
        `${styleTitle(rich)} ${styleVersion(version, opts.commit, rich)}`,
        styleTagline(tagline, rich),
        '',
        rich ? chalk.dim('Run `flopsy --help` to see commands.') : 'Run `flopsy --help` to see commands.',
    ];
    const visibleWidth = Math.max(...rabbit.map(visLen));
    const gutter = 3;
    const rows = Math.max(rabbit.length, info.length);
    for (let i = 0; i < rows; i++) {
        const left = rabbit[i] ?? '';
        const pad = ' '.repeat(Math.max(0, visibleWidth - visLen(left)) + gutter);
        console.log(left + pad + (info[i] ?? ''));
    }
    console.log('');
}

function safeUsername(): string {
    try {
        const u = userInfo().username;
        // Capitalise first letter for a friendlier greeting.
        return u.charAt(0).toUpperCase() + u.slice(1);
    } catch {
        return 'friend';
    }
}
