/**
 * Markdown → terminal ANSI renderer.
 *
 * Headings, lists, code blocks (with syntax highlighting), tables,
 * blockquotes, inline styles. Mirrors Claude Code's light markdown
 * tokeniser — no `marked` dep.
 */

import { Chalk } from 'chalk';
import stripAnsi from 'strip-ansi';
import { palette } from '../theme';
import { wrapVisible, truncateAnsi } from './text-utils';

// Force 24-bit color regardless of TTY detection at import time.
// The TUI always runs in a real terminal that supports truecolor.
const chalk = new Chalk({ level: 3 });

// ── lightweight syntax tokeniser (no highlight.js/Shiki dep) ───────────────

const KEYWORDS = new Set([
    // JS/TS
    'const', 'let', 'var', 'function', 'async', 'await', 'return', 'if',
    'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    'class', 'extends', 'new', 'this', 'super', 'import', 'export', 'from',
    'default', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof',
    'true', 'false', 'null', 'undefined', 'void', 'yield', 'of', 'in',
    'as', 'type', 'interface', 'enum', 'implements', 'private', 'public',
    'protected', 'readonly', 'static', 'abstract', 'declare', 'namespace',
    'module', 'require',
    // Python
    'def', 'lambda', 'pass', 'with', 'assert', 'del', 'except', 'raise',
    'global', 'nonlocal', 'and', 'or', 'not', 'is', 'None', 'True', 'False',
    'elif', 'print', 'self',
    // Rust / Go / other
    'fn', 'let', 'mut', 'pub', 'use', 'mod', 'struct', 'impl', 'trait',
    'enum', 'match', 'if', 'else', 'loop', 'while', 'for', 'in', 'return',
    'async', 'await', 'move', 'ref', 'where', 'dyn', 'Box', 'Option',
    'Result', 'Some', 'Ok', 'Err', 'Vec', 'String',
    'func', 'var', 'type', 'package', 'import', 'interface', 'struct',
    'map', 'chan', 'go', 'defer', 'select', 'range',
]);

const STRING_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const COMMENT_RE = /\/\/.*$|\/\*[\s\S]*?\*\//gm;
const HASH_COMMENT_RE = /#.*$/gm;
const NUMBER_RE = /\b\d+\.?\d*|\.\d+\b/g;

// Code block background — raw ANSI to avoid chalk nesting corruption.
// chalk.bgHex() re-processes inner ANSI sequences and can corrupt param
// strings like `38;2;86m` by matching them as close-code fragments.
// Raw bytes bypass that entirely: bg open + content + reset is safe.
const [R, G, B] = [0x0c, 0x1f, 0x0c];  // dark forest green
const CODE_BG_OPEN  = `\x1b[48;2;${R};${G};${B}m`;
const CODE_BG_CLOSE = '\x1b[49m';
const ANSI_RESET    = '\x1b[0m';

const comment = chalk.hex('#6A9955');
const string_ = chalk.hex('#CE9178');
const keyword = chalk.hex('#569CD6');
const number_ = chalk.hex('#B5CEA8');
const func_ = chalk.hex('#DCDCAA');
const call_ = chalk.hex('#C586C0');

// Returns true if position idx in str is inside an ANSI escape sequence
// (i.e. after \x1b[ and before the closing m/A/B/H/J/K etc.).
// Prevents later highlight passes from matching digits inside color codes.
function inAnsiSeq(str: string, idx: number): boolean {
    const chunk = str.slice(Math.max(0, idx - 40), idx);
    return /\x1b\[[0-9;]*$/.test(chunk);
}

function highlightCodeLine(line: string, lang: string): string {
    if (!lang || lang === 'text' || lang === 'plain' || lang === '') {
        return line;
    }

    let result = line;

    // Comments first — hash-style for Python/Ruby/shell, C-style for everything else
    const isPythonLike = /^(python|py|ruby|rb|sh|bash|zsh|toml|yaml|yml)$/i.test(lang);
    if (isPythonLike) {
        result = result.replace(HASH_COMMENT_RE, (m) => comment(m));
    } else {
        result = result.replace(COMMENT_RE, (m) => comment(m));
    }

    // Strings
    result = result.replace(STRING_RE, (m, idx: number, src: string) => {
        if (inAnsiSeq(src, idx)) return m;
        return string_(m);
    });

    // Keywords
    result = result.replace(
        /\b[a-zA-Z_$][\w$]*\b/g,
        (word, idx: number, src: string) => {
            if (inAnsiSeq(src, idx)) return word;

            if (KEYWORDS.has(word)) return keyword(word);
            if (src[idx + word.length] === '(') return call_(word);
            const prev = src.slice(Math.max(0, idx - 10), idx);
            if (/(?:function|async)\s+$/.test(prev)) return func_(word);
            return word;
        },
    );

    // Numbers — run last; skip positions inside ANSI sequences inserted above
    result = result.replace(NUMBER_RE, (m, idx: number, src: string) => {
        if (inAnsiSeq(src, idx)) return m;
        return number_(m);
    });

    return result;
}

// ── inline markdown styling ───────────────────────────────────────────────

const accent = chalk.hex('#D77757');
const blue   = chalk.hex(palette.channel);
const muted  = chalk.hex(palette.muted);

export function renderInline(text: string): string {
    return text
        .replace(/`([^`]+)`/g, (_, c: string) => chalk.hex(palette.channel)(c))
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) =>
            chalk.hex(palette.channel).underline(label) +
            muted(' (') +
            chalk.hex(palette.channel).underline(url) +
            muted(')'))
        .replace(/\b(https?:\/\/[^\s)\]]+)/g, (_, url: string) =>
            chalk.hex(palette.channel).underline(url))
        .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => chalk.hex(palette.warn).bold(t))
        .replace(/\*([^*]+)\*/g, (_, t: string) => chalk.italic(t));
}

// ── table sub-system ──────────────────────────────────────────────────────

type TableAlign = 'left' | 'center' | 'right';

function parseTableRow(line: string): string[] {
    const trimmed = line.trim().replace(/^\||\|$/g, '');
    return trimmed.split('|').map((s) => s.trim());
}

function parseTableSeparator(line: string): TableAlign[] {
    const trimmed = line.trim().replace(/^\||\|$/g, '');
    return trimmed.split('|').map((cell) => {
        const c = cell.trim();
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
    });
}

function padCellAlign(text: string, visLen: number, width: number, align: TableAlign): string {
    const slack = Math.max(0, width - visLen);
    if (align === 'right') return ' '.repeat(slack) + text;
    if (align === 'center') {
        const left = Math.floor(slack / 2);
        return ' '.repeat(left) + text + ' '.repeat(slack - left);
    }
    return text + ' '.repeat(slack);
}

export function parseMarkdownTable(
    lines: string[],
    startIdx: number,
): { rows: string[][]; aligns: TableAlign[]; endIdx: number } | null {
    const headerLine = lines[startIdx]!;
    const sepLine = lines[startIdx + 1];
    if (!sepLine) return null;

    const headerCells = parseTableRow(headerLine);
    const aligns = parseTableSeparator(sepLine);
    if (headerCells.length === 0) return null;

    const rows: string[][] = [headerCells];
    let i = startIdx + 2;
    while (i < lines.length) {
        const line = lines[i]!;
        if (!/^\s*\|.*\|\s*$/.test(line)) break;
        const cells = parseTableRow(line);
        while (cells.length < headerCells.length) cells.push('');
        rows.push(cells);
        i++;
    }

    while (aligns.length < headerCells.length) aligns.push('left');
    return { rows, aligns, endIdx: i };
}

function renderTableRow(
    cells: string[],
    widths: number[],
    aligns: TableAlign[],
    isHeader: boolean,
): string {
    const dim = muted;
    let line = dim('│');
    for (let i = 0; i < widths.length; i++) {
        const raw = cells[i] ?? '';
        let styled = renderInline(raw);
        if (isHeader) styled = chalk.bold(styled);
        const truncated = truncateAnsi(styled, widths[i]!);
        const visLen = (strippedLen(truncated));
        const padded = padCellAlign(truncated, visLen, widths[i]!, aligns[i] ?? 'left');
        line += ' ' + padded + ' ' + dim('│');
    }
    return line;
}

function strippedLen(s: string): number {
    return stripAnsi(s).length;
}

export function renderTable(rows: string[][], aligns: TableAlign[], availW: number): string[] {
    const dim = muted;
    const numCols = Math.max(...rows.map((r) => r.length));
    if (numCols === 0) return [];

    const renderedCells: string[][] = rows.map((row) =>
        row.map((c) => renderInline(c)),
    );

    const idealWidths: number[] = [];
    for (let c = 0; c < numCols; c++) {
        let max = 3;
        for (let r = 0; r < renderedCells.length; r++) {
            const cell = renderedCells[r]![c] ?? '';
            const len = strippedLen(cell);
            if (len > max) max = len;
        }
        idealWidths.push(max);
    }

    const chrome = 1 + numCols * 3;
    const idealSum = idealWidths.reduce((a, b) => a + b, 0);
    let columnWidths = idealWidths;
    if (chrome + idealSum > availW) {
        const slack = Math.max(numCols * 3, availW - chrome);
        const scale = slack / idealSum;
        columnWidths = idealWidths.map((w) => Math.max(3, Math.floor(w * scale)));
    }

    const buildBorder = (l: string, mid: string, r: string): string => {
        let s = l;
        columnWidths.forEach((w, i) => {
            s += '─'.repeat(w + 2);
            s += i < columnWidths.length - 1 ? mid : r;
        });
        return dim(s);
    };

    const out: string[] = [];
    out.push(buildBorder('┌', '┬', '┐'));
    out.push(renderTableRow(rows[0]!, columnWidths, aligns, true));
    out.push(buildBorder('├', '┼', '┤'));
    for (let r = 1; r < rows.length; r++) {
        out.push(renderTableRow(rows[r]!, columnWidths, aligns, false));
    }
    out.push(buildBorder('└', '┴', '┘'));
    return out;
}

// ── full markdown render ──────────────────────────────────────────────────

export function renderMarkdown(text: string, termWidth: number): string[] {
    const out: string[] = [];
    const indent = '  ';
    const innerW = Math.max(40, termWidth - indent.length - 2);
    const dim = muted;

    let inCode = false;
    let codeLang = '';
    let codeBuf: string[] = [];
    const lines = text.split('\n');

    // Raw-ANSI background: avoid chalk.bgHex wrapping existing ANSI sequences.
    // chalk's nesting logic replaces close-code patterns inside the content
    // which can fragment truecolor param strings (e.g. `38;2;86m`).
    const codeLine = (content: string): string => {
        const visLen = strippedLen(content);
        const pad = Math.max(0, innerW - visLen);
        return CODE_BG_OPEN + content + ' '.repeat(pad) + CODE_BG_CLOSE + ANSI_RESET;
    };

    const flushCodeBlock = (): void => {
        const lang = codeLang || 'code';
        if (codeBuf.length === 0) {
            out.push(indent + codeLine(dim('─── ' + lang + ' ───')));
            out.push(indent + codeLine(dim('─'.repeat(Math.min(8, innerW)))));
            return;
        }
        const digits = String(codeBuf.length).length;
        const dashes = '─'.repeat(Math.max(3, innerW - digits - 6 - lang.length));
        out.push(indent + codeLine(dim(`─── ${lang} ${dashes}`)));
        for (let i = 0; i < codeBuf.length; i++) {
            // dim() = muted hex color — uses `\x1b[39m` close, safe to concatenate
            const num = dim(String(i + 1).padStart(digits, ' ') + ' ');
            const highlighted = highlightCodeLine(codeBuf[i]!, codeLang);
            out.push(indent + codeLine(num + highlighted));
        }
        out.push(indent + codeLine(dim('─'.repeat(innerW))));
        codeBuf = [];
        codeLang = '';
    };

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const raw = lines[lineIdx]!;

        // table detection (before fence detection so `|---|` doesn't match)
        if (!inCode && /^\s*\|.*\|\s*$/.test(raw)) {
            const sep = lines[lineIdx + 1];
            if (sep && /^\s*\|[\s:|\-]+\|\s*$/.test(sep)) {
                const tbl = parseMarkdownTable(lines, lineIdx);
                if (tbl) {
                    for (const tl of renderTable(tbl.rows, tbl.aligns, innerW))
                        out.push(indent + tl);
                    lineIdx = tbl.endIdx - 1;
                    continue;
                }
            }
        }

        const fenceMatch = raw.match(/^```(\w*)/);
        if (fenceMatch) {
            if (!inCode) {
                inCode = true;
                codeLang = fenceMatch[1] ?? '';
                codeBuf = [];
            } else {
                inCode = false;
                flushCodeBlock();
            }
            continue;
        }

        if (inCode) {
            codeBuf.push(raw);
            continue;
        }

        // headings
        const heading = raw.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            const depth = heading[1]!.length;
            const inner = renderInline(heading[2]!);
            const styled =
                depth === 1 ? accent.bold.underline(inner) :
                depth === 2 ? chalk.bold(inner) :
                              dim.bold(inner);
            for (const wl of wrapVisible(styled, innerW)) out.push(indent + wl);
            continue;
        }

        // blockquote
        const blockquote = raw.match(/^>\s?(.*)$/);
        if (blockquote) {
            const styled = chalk.italic(renderInline(blockquote[1]!));
            for (const wl of wrapVisible(styled, innerW - 2)) {
                out.push(indent + blue('▎ ') + wl);
            }
            continue;
        }

        // horizontal rule
        if (/^([-*_])\1{2,}\s*$/.test(raw)) {
            out.push(indent + dim('─'.repeat(Math.min(40, innerW))));
            continue;
        }

        // bulleted list
        const bullet = raw.match(/^(\s*)[-*+]\s+(.*)$/);
        if (bullet) {
            const lead = bullet[1] ?? '';
            const body = renderInline(bullet[2]!);
            const wrapW = Math.max(20, innerW - lead.length - 2);
            const wrapped = wrapVisible(body, wrapW);
            wrapped.forEach((wl, i) => {
                const prefix = i === 0 ? `${lead}${accent('·')} ` : `${lead}  `;
                out.push(indent + prefix + wl);
            });
            continue;
        }

        // ordered list
        const ordered = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
        if (ordered) {
            const lead = ordered[1] ?? '';
            const num = ordered[2]!;
            const body = renderInline(ordered[3]!);
            const wrapW = Math.max(20, innerW - lead.length - num.length - 2);
            const wrapped = wrapVisible(body, wrapW);
            wrapped.forEach((wl, i) => {
                const prefix = i === 0
                    ? `${lead}${accent(num + '.')} `
                    : `${lead}${' '.repeat(num.length + 2)}`;
                out.push(indent + prefix + wl);
            });
            continue;
        }

        const rendered = renderInline(raw);
        for (const wl of wrapVisible(rendered, innerW)) out.push(indent + wl);
    }

    if (inCode) flushCodeBlock();
    return out;
}