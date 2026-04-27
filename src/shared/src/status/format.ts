/**
 * Pure formatters shared by every status renderer. No I/O, no imports from
 * CLI theming (that lives in the CLI package) — callers pass colour functions
 * in when they want them.
 */

/** ms → "3s" / "5m 20s" / "2h 15m" / "3d 4h" */
export function humanDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}

/** ms ago → "4m ago" / "2h ago" — compact, for status display */
export function agoLabel(ms: number): string {
    if (ms < 60_000) return 'just now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}

/** 1234 → "1.2k" / 1.5M → "1.5M" / <1000 → bare int */
export function formatCount(n: number): string {
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Collapse $HOME to `~` so long paths stay readable. */
export function tildePath(p: string): string {
    const home = process.env['HOME'];
    if (home && (p === home || p.startsWith(home + '/'))) {
        return '~' + p.slice(home.length);
    }
    return p;
}

export function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, Math.max(1, max - 1)) + '…';
}

/** Channel-safe emoji palette (no ANSI). */
export const EMOJI = {
    run: '🟢',
    stop: '🔴',
    warn: '🟡',
    off: '⚪',
    ok: '✅',
    no: '❌',
    working: '🔵',
    idle: '💤',
    hook: '🪝',
    proactive: '⏰',
    paused: '⏸️',
    bullet: '·',
    dot: '●',
    circle: '○',
} as const;

/** Terminal glyphs (used by CLI renderers — may include ANSI-style chars). */
export const GLYPH = {
    diamond: '◆',
    dot: '●',
    circle: '○',
    bullet: '·',
    arrow: '→',
    delivered: '↓',
    suppressed: '✕',
    error: '!',
    queue: 'q',
    check: '✓',
    cross: '✗',
} as const;
