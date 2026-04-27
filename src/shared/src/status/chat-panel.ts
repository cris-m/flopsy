/**
 * chat-panel — unified renderer for slash-command output in chat.
 *
 * Goal: match the visual register of professional CLI tools (Hermes, kubectl,
 * gh) when rendered in Telegram/Discord/Slack/Mattermost. Both adapters
 * render fenced code blocks with monospace alignment, so we use that as the
 * carrier and avoid bold/italic markdown decoration.
 *
 * Design rules:
 *   - One section header style: `◆ TITLE`
 *   - Two state glyphs: `●` (active/ok) and `○` (idle/off)
 *   - Three severity glyphs: `✓` (ok), `!` (warn), `✗` (fail)
 *   - Fixed-width column alignment via padEnd — never tabs
 *   - No emoji theatre (no 🔵 💤 ⚪ 🟢 ⏳ ▶️ 🛑 …)
 */

const FENCE = '```';

export interface PanelSection {
    /** Section heading. Rendered uppercase with `◆` prefix. */
    readonly title: string;
    /** Lines under the heading. Empty array → header only. */
    readonly lines: readonly string[];
}

export interface PanelOptions {
    /**
     * Single line shown above all sections, e.g. the panel title or a one-line
     * summary like "STATUS · gandalf · 4/5 agents".
     */
    readonly header?: string;
    /** Optional caption rendered after the closing fence (regular markdown allowed). */
    readonly footer?: string;
}

/**
 * Render a multi-section panel as a fenced code block.
 * Empty sections (no lines + no title) are dropped so the panel is dense.
 */
export function panel(sections: readonly PanelSection[], opts: PanelOptions = {}): string {
    const out: string[] = [FENCE];
    if (opts.header) {
        out.push(opts.header);
        // Underline the header with `─` characters as wide as the header itself,
        // so chat clients that render code blocks at any width still get a visible rule.
        out.push('─'.repeat(Math.min(opts.header.length, 60)));
    }
    let first = true;
    for (const section of sections) {
        const hasContent = section.title || section.lines.length > 0;
        if (!hasContent) continue;
        if (!first) out.push('');
        first = false;
        if (section.title) out.push(`◆ ${section.title.toUpperCase()}`);
        for (const ln of section.lines) out.push(ln);
    }
    out.push(FENCE);
    if (opts.footer) {
        out.push('');
        out.push(opts.footer);
    }
    return out.join('\n');
}

/**
 * Format a key/value row with the key padded to `keyWidth` columns.
 * Use inside section lines for tabular data.
 *
 *   row('gateway', 'running', 12) → 'gateway     running'
 */
export function row(key: string, value: string, keyWidth = 14): string {
    return `  ${key.padEnd(keyWidth)} ${value}`;
}

/**
 * Multi-column row: pads each cell to its width except the last.
 * Use for task/team listings:
 *
 *   cols([['● legolas', 18], ['working', 10], ['"fetch weather"', 0]])
 *     → '  ● legolas         working    "fetch weather"'
 */
export function cols(cells: ReadonlyArray<readonly [string, number]>): string {
    return (
        '  ' +
        cells
            .map(([text, width], i) => (i === cells.length - 1 ? text : text.padEnd(width)))
            .join(' ')
    );
}

/** Compact one-line panel — title + value, no fence (used for terse replies). */
export function line(title: string, value: string): string {
    return `${FENCE}\n${title.toUpperCase()}\n  ${value}\n${FENCE}`;
}

/** State glyphs — keep this set MINIMAL. */
export const STATE = {
    on: '●',
    off: '○',
    ok: '✓',
    warn: '!',
    fail: '✗',
    arrow: '→',
    bullet: '·',
} as const;
