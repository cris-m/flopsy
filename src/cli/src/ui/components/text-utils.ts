/**
 * Text utility functions shared across TUI components.
 *
 *   wrapVisible()   — ANSI-aware word-wrap
 *   truncateAnsi()  — truncate with ellipsis, preserving ANSI
 *   center()/padRight() — layout helpers
 *   fmtElapsed()   — duration formatting
 *   fmtTok()       — token count formatting (1.2K, 3.5M)
 */

import stripAnsi from 'strip-ansi';

const ESC = '\x1b';

export function center(s: string, width: number): string {
    const vis = stripAnsi(s).length;
    if (vis >= width) return s;
    const pad = Math.floor((width - vis) / 2);
    return ' '.repeat(pad) + s;
}

export function padRight(s: string, width: number): string {
    const vis = stripAnsi(s).length;
    return vis < width ? s + ' '.repeat(width - vis) : s;
}

/** Width-aware single-line word wrap. Splits at last space ≤ width when possible. */
export function wrapVisible(text: string, width: number): string[] {
    if (width <= 0) return [text];
    const visualLen = stripAnsi(text).length;
    if (visualLen <= width) return [text];

    const out: string[] = [];
    let segStart = 0;
    let visCount = 0;
    let lastSpace = -1;
    let i = 0;
    const n = text.length;

    while (i < n) {
        if (text.charCodeAt(i) === 0x1b && text[i + 1] === '[') {
            let end = i + 2;
            while (end < n && text[end] !== 'm') end++;
            i = end + 1;
            continue;
        }

        if (text[i] === ' ') lastSpace = i;
        visCount++;
        i++;

        if (visCount >= width) {
            const cut = lastSpace > segStart ? lastSpace : i;
            out.push(text.slice(segStart, cut).trimEnd());
            let next = cut;
            while (next < n && text[next] === ' ') next++;
            segStart = next;
            i = next;
            visCount = 0;
            lastSpace = -1;
            if (segStart === cut && cut === i) i = segStart + 1;
        }
    }

    if (segStart < n) {
        const tail = text.slice(segStart);
        if (tail) out.push(tail);
    }
    return out;
}

/** Truncate an ANSI-styled string to `width` visible chars + ellipsis. */
export function truncateAnsi(text: string, width: number): string {
    if (stripAnsi(text).length <= width) return text;
    let visCount = 0;
    let rawIdx = 0;
    while (rawIdx < text.length && visCount < width - 1) {
        if (text[rawIdx] === ESC && text[rawIdx + 1] === '[') {
            let end = rawIdx + 2;
            while (end < text.length && text[end] !== 'm') end++;
            rawIdx = end + 1;
            continue;
        }
        visCount++;
        rawIdx++;
    }
    return text.slice(0, rawIdx) + '…';
}

export function fmtElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtTok(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

/** Strip ANSI and return visible length. */
export function stripLen(s: string): number {
    return stripAnsi(s).length;
}