/**
 * ChatTUI — modular terminal chat client for `flopsy chat`.
 *
 * Orchestrates components:
 *   components/chat-log.ts        — scrollback buffer
 *   components/status-bar.ts      — bottom status bar
 *   components/markdown-renderer.ts — full markdown → ANSI
 *   components/tool-display.ts    — tool call/result rendering
 *   components/thinking-block.ts  — thinking text rendering
 *   components/user-message.ts    — user message gray block
 *   components/slash-hints.ts     — slash command popup
 *   input/input-handler.ts        — keyboard input handling
 */

import chalk from 'chalk';
import cliBoxes from 'cli-boxes';
import { userInfo } from 'node:os';
import { palette, tint } from './theme';
import { styleRabbit, getRecentActivity, formatRelative } from './banner';
import { ChatLog } from './components/chat-log';
import { renderMarkdown } from './components/markdown-renderer';
import { center, fmtElapsed, fmtTok, padRight, stripLen, wrapVisible } from './components/text-utils';
import {
    buildToolStartLine,
    buildToolDoneLine,
    buildToolDurationLine,
    formatToolResultLines,
    isToolError,
} from './components/tool-display';
import { buildThinkingLines } from './components/thinking-block';
import { renderUserMessage } from './components/user-message';
import { renderSlashHints, getSlashMatches } from './components/slash-hints';
import { InputHandler, type InputState } from './input/input-handler';

const ESC = '\x1b';
const write = (s: string): void => { process.stdout.write(s); };
const cols = (): number => process.stdout.columns || 80;

const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_SCREEN = `${ESC}[2J`;
const ENABLE_BRACKETED = `${ESC}[?2004h`;
const DISABLE_BRACKETED = `${ESC}[?2004l`;
const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
const LEAVE_ALT_SCREEN = `${ESC}[?1049l`;
const RESET_SCROLL_REGION = `${ESC}[r`;
const moveTo = (row: number, col: number): string => `${ESC}[${row};${col}H`;
const clearLine = `${ESC}[2K`;

const THINK_BASE = process.platform === 'darwin'
    ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽'];
const THINK_SPIN = [...THINK_BASE, ...[...THINK_BASE].reverse()];

export interface ChatTUICallbacks {
    onSend(text: string): void;
    onInterrupt(): void;
    onQuit(): void;
}

export class ChatTUI {
    // ── components ────────────────────────────────────────────────────────
    private log = new ChatLog();
    private input = new InputHandler({
        onSubmit: () => this.submit(),
        onQuit: () => this.cbs.onQuit(),
        onRedraw: () => this.redraw(),
        onToggleExpand: () => this.toggleExpansion(),
        onPageUp:   () => this.scrollUp(this.pageSize()),
        onPageDown: () => this.scrollDown(this.pageSize()),
    });

    // ── state ─────────────────────────────────────────────────────────────
    private streaming = false;
    private threadId = '';
    private model = '';
    private cwd = '';
    private tokenIn = 0;
    private tokenOut = 0;
    private tokenReasoning = 0;
    private tokenCached = 0;

    private toolsExpanded = false;
    private thinkingVisible = true;

    private thinkActive = false;
    private thinkFrame = 0;
    private thinkInterval: ReturnType<typeof setInterval> | null = null;

    // 1s clock tick — keeps the status bar elapsed time alive
    private clockInterval: ReturnType<typeof setInterval> | null = null;

    private activeTool: { name: string; args?: string; startedAt: number } | null = null;
    private activeToolLogIndex: number | null = null;

    private thinkBuf = '';
    private thinkStartIndex: number | null = null;
    private thinkLineCount = 0;

    private streamTextBuf = '';
    private streamTextStartIndex: number | null = null;
    private streamTextLineCount = 0;

    private sessionStart = Date.now();
    private turnCount = 0;
    private responseStartMs = 0;
    private lastResponseMs = 0;
    private contextTokens = 0;
    private contextLimit: number | null = null;

    setContextUsage(used: number, limit: number | null): void {
        this.contextTokens = used;
        this.contextLimit = limit;
    }

    private lastInputH = 1;
    private scrollOffset = 0;
    private unreadSince = 0;

    constructor(private readonly cbs: ChatTUICallbacks) {}

    // ── lifecycle ─────────────────────────────────────────────────────────

    start(): void {
        write(ENTER_ALT_SCREEN);
        write(HIDE_CURSOR);
        write(ENABLE_BRACKETED);
        write(CLEAR_SCREEN);
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.on('data', (d: Buffer) => this.input.handle(d));
        process.stdout.on('resize', () => this.repaintAll());
        // 1s tick so the elapsed-time counter updates without user input
        this.clockInterval = setInterval(() => this.redraw(), 1000);
        this.clockInterval.unref();
        this.repaintAll();
    }

    stop(): void {
        this.stopThink();
        if (this.clockInterval !== null) { clearInterval(this.clockInterval); this.clockInterval = null; }
        write(RESET_SCROLL_REGION);
        write(DISABLE_BRACKETED);
        write(SHOW_CURSOR);
        write(LEAVE_ALT_SCREEN);
        try { process.stdin.setRawMode?.(false); } catch { /* */ }
        process.stdin.pause();
    }

    // ── public API ────────────────────────────────────────────────────────

    showWelcome(threadId: string, model: string): void {
        this.threadId = threadId;
        this.model = model;

        const c = cols();
        const boxWidth = c;
        const box = cliBoxes.round;
        const pb = (s: string) => chalk.hex(palette.brand)(s);
        const dim = (s: string) => chalk.hex(palette.muted)(s);
        const blue = (s: string) => chalk.hex(palette.channel)(s);

        const rabbit = styleRabbit(true).split('\n').filter((l) => l.trim().length > 0);
        const name = (() => { try { return userInfo().username; } catch { return 'local'; } })();
        const cwdAbs = process.cwd();
        const home = process.env['HOME'] ?? '';
        const cwdShort = home && cwdAbs.startsWith(home) ? '~' + cwdAbs.slice(home.length) : cwdAbs;

        const innerW = boxWidth - 2;
        const leftW = Math.max(28, Math.floor(innerW * 0.42));
        const rightW = innerW - leftW - 5;

        const titleInline = ` ${tint.brand.bold('FlopsyBot')} ${chalk.dim('v1.0.0')} `;
        const titleVis = stripLen(titleInline);
        const leftDashes = 3;
        const rightDashes = Math.max(1, innerW - titleVis - leftDashes);
        const topBar = pb(box.topLeft) + pb(box.top.repeat(leftDashes)) +
            titleInline + pb(box.top.repeat(rightDashes)) + pb(box.topRight);
        const botBar = pb(box.bottomLeft) + pb(box.bottom.repeat(innerW)) + pb(box.bottomRight);

        const truncatePlain = (s: string, w: number): string =>
            stripLen(s) <= w ? s : s.slice(0, w - 1) + '…';

        const leftLines = [
            '', center(chalk.bold(`Welcome back ${name}!`), leftW), '',
            ...rabbit.map((r) => center(r, leftW)), '',
            center(`${tint.brand.bold('FlopsyBot')} ${chalk.dim('v1.0.0')}`, leftW),
            center(chalk.italic.dim('a little rabbit, a lot of tools'), leftW), '',
            center(chalk.dim(truncatePlain(cwdShort, leftW)), leftW), '',
        ];

        const tips: ReadonlyArray<readonly [string, string]> = [
            ['/help', 'list commands'], ['/new', 'start a fresh session'],
            ['/compact', 'summarise + free context'], ['/status', 'gateway snapshot'],
        ];
        const renderTip = (cmd: string, what: string): string => {
            const line = ` • ${blue(cmd)} ${dim('—')} ${what}`;
            return truncatePlain(line, rightW);
        };

        const activity = getRecentActivity(3);
        const activityLines = activity.length === 0
            ? [dim(' • no recent activity')]
            : activity.map(({ label, mtimeMs }) => {
                const rel = formatRelative(mtimeMs);
                return truncatePlain(` • ${label} ${dim('—')} ${rel}`, rightW);
            });

        const dash = dim('─'.repeat(Math.max(6, rightW)));
        const rightLines = [
            '', chalk.bold('Tips for getting started'),
            ...tips.map(([cmd, what]) => renderTip(cmd, what)),
            '', dash, '', chalk.bold('Recent activity'), ...activityLines, '',
        ];

        const numRows = Math.max(leftLines.length, rightLines.length);
        this.scrollbackLine('');
        this.scrollbackLine(' ' + topBar);
        for (let i = 0; i < numRows; i++) {
            const l = padRight(leftLines[i] ?? '', leftW);
            const r = padRight(rightLines[i] ?? '', rightW);
            this.scrollbackLine(` ${pb(box.left)} ${l} ${dim('│')} ${r} ${pb(box.right)}`);
        }
        this.scrollbackLine(' ' + botBar);
        this.scrollbackLine('');
    }

    setCwd(path: string): void { this.cwd = path; }
    setTokens(input: number, output: number, reasoning?: number, cached?: number): void {
        this.tokenIn += input;
        this.tokenOut += output;
        if (reasoning) this.tokenReasoning += reasoning;
        if (cached) this.tokenCached += cached;
        this.redraw();
    }

    setStreaming(v: boolean): void {
        this.streaming = v;
        if (v) {
            this.responseStartMs = Date.now();
            this.lastResponseMs = 0;
            if (this.thinkingVisible) {
                this.stopThink();
                this.thinkActive = true;
                this.thinkFrame = 0;
                this.thinkInterval = setInterval(() => {
                    this.thinkFrame = (this.thinkFrame + 1) % THINK_SPIN.length;
                    this.redraw();
                }, 160);
            }
        } else {
            this.lastResponseMs = Date.now() - this.responseStartMs;
            this.activeTool = null;
            this.activeToolLogIndex = null;
            this.stopThink();
        }
        this.redraw();
    }

    addUserMessage(text: string): void {
        for (const line of renderUserMessage(text, cols())) this.scrollbackLine(line);
        this.redraw();
    }

    streamThinking(text: string): void {
        if (!text) return;
        if (this.thinkStartIndex === null) {
            this.thinkBuf = text;
            this.thinkStartIndex = this.log.length;
            this.thinkLineCount = 0;
        } else {
            this.thinkBuf += text;
        }
        this.renderThinkingBlock();
    }

    flushThinking(): void {
        if (this.thinkLineCount > 0) { this.log.push(''); this.repaintScrollRegion(); }
        this.thinkBuf = '';
        this.thinkStartIndex = null;
        this.thinkLineCount = 0;
    }

    addToolStart(name: string, args?: string): void {
        this.activeTool = { name, args, startedAt: Date.now() };
        this.flushThinking();
        this.stopThink();
        const line = buildToolStartLine(name, args);
        this.activeToolLogIndex = this.log.length;
        this.scrollbackLine(line);
        this.redraw();
    }

    addToolDone(name: string, durationMs: number, result?: string): void {
        const startedArgs = this.activeTool?.args;
        this.activeTool = null;
        const err = isToolError(result);
        const doneLine = buildToolDoneLine(name, startedArgs, err);
        if (this.activeToolLogIndex !== null && this.activeToolLogIndex < this.log.length) {
            this.log.setAt(this.activeToolLogIndex, doneLine);
        } else {
            this.log.push(doneLine);
        }
        if (result?.trim()) {
            for (const l of formatToolResultLines(result, cols(), err)) this.log.push(l);
        }
        this.log.push(buildToolDurationLine(durationMs));
        this.log.push('');
        this.activeToolLogIndex = null;
        this.repaintScrollRegion();

        if (this.streaming) {
            this.thinkActive = true;
            this.thinkFrame = 0;
            this.thinkInterval = setInterval(() => {
                this.thinkFrame = (this.thinkFrame + 1) % THINK_SPIN.length;
                this.redraw();
            }, 160);
        }
        this.redraw();
    }

    streamAssistantDelta(delta: string): void {
        if (!delta) return;
        this.flushThinking();
        this.streamTextBuf += delta;
        if (this.streamTextStartIndex === null) {
            this.log.push('');
            this.streamTextStartIndex = this.log.length;
            this.streamTextLineCount = 0;
        }
        this.renderStreamingTextBlock();
    }

    private renderStreamingTextBlock(): void {
        if (this.streamTextStartIndex === null) return;
        // Cheap word-wrap during streaming — full markdown (syntax highlighting,
        // tables, ANSI injection) runs only once on `done` via addAssistantText.
        // Calling renderMarkdown on every delta is O(n²) and stalls the terminal
        // on code-heavy responses.
        const w = Math.max(40, cols() - 4);
        const newLines: string[] = [];
        for (const line of this.streamTextBuf.split('\n')) {
            for (const wl of wrapVisible(line, w)) newLines.push('  ' + wl);
        }
        this.log.splice(this.streamTextStartIndex, this.streamTextLineCount, ...newLines);
        this.streamTextLineCount = newLines.length;
        this.repaintScrollRegion();
    }

    addAssistantText(text: string): void {
        if (!text) return;
        this.flushThinking();
        this.turnCount++;

        if (this.streamTextStartIndex !== null) {
            // Replace the progressively-rendered raw block with final markdown.
            // The leading '' was pushed before streamTextStartIndex, so offset by -1.
            const finalLines = renderMarkdown(text, cols());
            this.log.splice(this.streamTextStartIndex - 1, this.streamTextLineCount + 1, '', ...finalLines, '');
            this.streamTextBuf = '';
            this.streamTextStartIndex = null;
            this.streamTextLineCount = 0;
            this.repaintScrollRegion();
            this.redraw();
            return;
        }

        this.scrollbackLine('');
        for (const line of renderMarkdown(text, cols())) this.scrollbackLine(line);
        this.scrollbackLine('');
        this.redraw();
    }

    addError(msg: string): void {
        this.activeTool = null;
        this.stopThink();
        this.scrollbackLine('');
        this.scrollbackLine(`  ${chalk.red('✗')} ${chalk.red(msg)}`);
        this.scrollbackLine('');
        this.redraw();
    }

    addTaskEvent(kind: 'start' | 'progress' | 'complete' | 'error', taskId: string, info?: string): void {
        const dim = chalk.hex(palette.muted);
        const tag = dim(`task #${taskId}`);
        const detail = info ? ' · ' + dim(info.length > 80 ? info.slice(0, 79) + '…' : info) : '';
        let line: string;
        switch (kind) {
            case 'start':   line = `  ${chalk.cyan('◇')} ${tag} ${dim('started')}${detail}`; break;
            case 'progress': line = `  ${dim('·')} ${tag}${detail}`; break;
            case 'complete': line = `  ${chalk.hex(palette.success)('◆')} ${tag} ${dim('done')}${detail}`; break;
            case 'error':    line = `  ${chalk.red('✗')} ${tag} ${chalk.red('failed')}${detail}`; break;
        }
        this.scrollbackLine(line);
        this.redraw();
    }

// ── recovery ────────────────────────────────────────────────────────────

    /** Reset all streaming/intermediate state — called on disconnect to avoid stale spinners. */
    resetState(): void {
        this.stopThink();
        this.streaming = false;
        this.thinkBuf = '';
        this.thinkStartIndex = null;
        this.thinkLineCount = 0;
        this.streamTextBuf = '';
        this.streamTextStartIndex = null;
        this.streamTextLineCount = 0;
        this.activeTool = null;
        this.activeToolLogIndex = null;
        this.flushThinking();
    }

    /** Clear the scrollback buffer and repaint (for /clear or /new). */
    clear(): void {
        this.log.clear();
        this.activeTool = null;
        this.activeToolLogIndex = null;
        this.turnCount = 0;
        this.scrollOffset = 0;
        this.unreadSince = 0;
        this.thinkBuf = '';
        this.thinkStartIndex = null;
        this.thinkLineCount = 0;
        this.repaintAll();
    }

    // ── core rendering ────────────────────────────────────────────────────

    private scrollbackLine(content: string): void {
        this.log.push(content);
        if (this.scrollOffset > 0) this.unreadSince++;
        this.repaintScrollRegion();
    }

    private repaintScrollRegion(): void {
        const R = process.stdout.rows || 24;
        const top = 1;
        const reservedBottom = this.lastInputH + 2; // input + 2-line status
        const bottom = Math.max(top, R - reservedBottom);
        const visibleRows = Math.max(0, bottom - top + 1);

        const maxOffset = Math.max(0, this.log.length - visibleRows);
        if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

        const end = this.log.length - this.scrollOffset;
        const start = Math.max(0, end - visibleRows);
        const visible = this.log.visibleSlice(start, end);

        for (let r = top; r <= bottom; r++) write(moveTo(r, 1) + clearLine);
        const startRow = this.log.length <= visibleRows ? top : bottom - visible.length + 1;
        for (let i = 0; i < visible.length; i++) write(moveTo(startRow + i, 1) + visible[i]!);
    }

    private buildInputRegion(): string[] {
        const dim = (s: string) => chalk.hex(palette.muted)(s);
        const c = cols();
        const lines: string[] = [];
        const boxW = Math.max(40, c - 4);
        const leftPad = Math.max(0, Math.floor((c - boxW) / 2));
        const pw = (s: string) => ' '.repeat(leftPad) + s;

        // Top border
        lines.push(pw(dim('┌' + '─'.repeat(boxW) + '┐')));

        // Input line
        for (const il of this.input.renderInputLines(boxW)) {
            const visLen = stripLen(il);
            const padding = ' '.repeat(Math.max(0, boxW - visLen));
            lines.push(pw(dim('│') + il + padding + dim('│')));
        }

        // Bottom border
        lines.push(pw(dim('└' + '─'.repeat(boxW) + '┘')));

        // Slash hints below the box
        for (const h of renderSlashHints(this.input.state.buf, this.input.state.slashHintIdx, c)) lines.push(h);

        return lines;
    }

    private redraw(): void {
        const c = cols();
        const R = process.stdout.rows || 24;
        const maxInputH = Math.max(3, Math.floor(R / 2));
        const inputLines = this.buildInputRegion();
        const lines = inputLines.length > maxInputH ? inputLines.slice(-maxInputH) : inputLines;
        const newH = lines.length;

        if (newH !== this.lastInputH) {
            this.lastInputH = newH;
            this.setScrollRegion();
            this.repaintScrollRegion();
        }

        // Think line (between scrollback and input).
        // Always write this row — if not streaming/active, write clearLine so
        // old "· working…" text doesn't persist after the turn ends.
        {
            const thinkRow = Math.max(1, R - newH - 2);
            const showThink = this.streaming && (this.thinkActive || this.activeTool);
            write(moveTo(thinkRow, 1) + clearLine + (showThink ? this.thinkLine() : ''));
        }

        // Input area
        const inputStartRow = Math.max(1, R - newH - 1);
        for (let i = 0; i < newH; i++) {
            write(moveTo(inputStartRow + i, 1) + clearLine + lines[i]!);
        }

        // Status bar — two lines at the very bottom
        this.renderStatusBar(c, R);
    }

    private renderStatusBar(c: number, R: number): void {
        const dim = (s: string) => chalk.hex(palette.muted)(s);
        const w = Math.max(1, c);

        const home = process.env['HOME'] ?? '';
        const cwdDisp = this.cwd ? this.cwd.replace(home, '~') : '';
        const branch = (globalThis as any).__flopsyGitBranch ?? '';

        // Line 1 (R-1): cwd + branch on left, turns · elapsed · model on right
        const left1 = dim(cwdDisp + (branch ? ' ' + chalk.hex(palette.channel)(branch) : ''));
        const rightParts1: string[] = [];
        if (this.turnCount > 0) rightParts1.push(dim(`Σ ${this.turnCount}`));
        // Elapsed: during streaming show live timer, after show last response duration
        const dur = this.streaming
            ? Date.now() - this.responseStartMs
            : this.lastResponseMs;
        rightParts1.push(dim(fmtElapsed(dur)));
        rightParts1.push(this.model
            ? chalk.hex(palette.channel)(this.model)
            : chalk.hex(palette.warn)('connecting…'));
        const right1 = rightParts1.join(' · ');

        const leftVis = stripLen(left1);
        const rightVis = stripLen(right1);
        const line1 = leftVis + rightVis + 1 <= w
            ? left1 + ' '.repeat(w - leftVis - rightVis) + right1
            : left1;

        // Line 2 (R): tokens + context usage, left-aligned
        const rightParts2: string[] = [];
        const tokenParts = [`↑${fmtTok(this.tokenIn)} ↓${fmtTok(this.tokenOut)}`];
        if (this.tokenReasoning > 0) tokenParts.push(`✦${fmtTok(this.tokenReasoning)}`);
        if (this.tokenCached > 0) tokenParts.push(`◆${fmtTok(this.tokenCached)}`);
        rightParts2.push(dim(tokenParts.join(' ')));
        if (this.contextTokens > 0) {
            const limitSuffix = this.contextLimit && this.contextLimit > 0
                ? `/${fmtTok(this.contextLimit)}`
                : '';
            rightParts2.push(dim(`ctx ${fmtTok(this.contextTokens)}${limitSuffix}`));
            if (this.contextTokens >= 80_000) {
                rightParts2.push(chalk.hex(palette.warn)('⚠ ctx filling'));
            }
        }
        const line2 = rightParts2.join(' ');

        write(moveTo(R - 1, 1) + clearLine + line1);
        write(moveTo(R, 1) + clearLine + line2);
    }

    private repaintAll(): void {
        write(CLEAR_SCREEN);
        write(RESET_SCROLL_REGION);
        this.setScrollRegion();
        this.repaintScrollRegion();
        this.redraw();
    }

    private setScrollRegion(): void {
        const R = process.stdout.rows || 24;
        const top = 1;
        const reservedBottom = this.lastInputH + 2; // input lines + 2-line status
        const bottom = Math.max(top, R - reservedBottom);
        write(`${ESC}[${top};${bottom}r`);
    }

    private thinkLine(): string {
        const sym = chalk.hex('#D77757')(THINK_SPIN[this.thinkFrame % THINK_SPIN.length]!);
        return `  ${sym} ` + chalk.hex(palette.muted).italic('working…');
    }

    private renderThinkingBlock(): void {
        if (this.thinkStartIndex === null) return;
        const newLines = buildThinkingLines(this.thinkBuf, cols(), this.thinkingVisible);
        this.log.splice(this.thinkStartIndex, this.thinkLineCount, ...newLines);
        this.thinkLineCount = newLines.length;
        this.repaintScrollRegion();
    }

    /** Toggle tool/thinking expansion (Ctrl+O). */
    toggleExpansion(): void {
        if (this.scrollOffset > 0) {
            this.scrollOffset = 0;
            this.unreadSince = 0;
            this.repaintScrollRegion();
            this.redraw();
            return;
        }
        this.toolsExpanded = !this.toolsExpanded;
        this.thinkingVisible = !this.thinkingVisible;
        if (!this.thinkingVisible) {
            this.thinkBuf = '';
            this.thinkStartIndex = null;
            this.thinkLineCount = 0;
            this.stopThink();
        }
        this.repaintScrollRegion();
        this.redraw();
    }

    // ── scroll ─────────────────────────────────────────────────────────────

    scrollUp(n: number): void {
        const R = process.stdout.rows || 24;
        const reservedBottom = this.lastInputH + 2;
        const visibleRows = Math.max(1, R - reservedBottom);
        const maxOffset = Math.max(0, this.log.length - visibleRows);
        const before = this.scrollOffset;
        this.scrollOffset = Math.min(maxOffset, this.scrollOffset + n);
        if (this.scrollOffset !== before) {
            if (before === 0) this.unreadSince = 0;
            this.repaintScrollRegion();
            this.redraw();
        }
    }

    scrollDown(n: number): void {
        const before = this.scrollOffset;
        this.scrollOffset = Math.max(0, this.scrollOffset - n);
        if (this.scrollOffset === 0) this.unreadSince = 0;
        if (this.scrollOffset !== before) {
            this.repaintScrollRegion();
            this.redraw();
        }
    }

    pageSize(): number {
        const R = process.stdout.rows || 24;
        const reservedBottom = this.lastInputH + 2;
        const visibleRows = Math.max(1, R - reservedBottom);
        return Math.max(1, visibleRows - 2);
    }

    // ── submit ─────────────────────────────────────────────────────────────

    private submit(): void {
        const text = this.input.consume();
        if (!text) return;
        if (text === '/exit' || text === '/quit' || text === '/q') {
            this.cbs.onQuit();
            return;
        }
        this.redraw();
        this.cbs.onSend(text);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private stopThink(): void {
        if (this.thinkInterval !== null) { clearInterval(this.thinkInterval); this.thinkInterval = null; }
        this.thinkActive = false;
    }
}