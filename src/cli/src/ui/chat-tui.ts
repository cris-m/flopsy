/**
 * ChatTUI — terminal chat client for `flopsy chat`.
 *
 * Rendering strategy (pi-tui pattern):
 *   - No alternate screen buffer. Output flows into the terminal's native
 *     scrollback so Cmd+↑, mouse-wheel, copy/paste, and Cmd+F all work.
 *   - History (committed messages) is written via stdout newlines and
 *     scrolls naturally. We don't track it after writing.
 *   - Mutable region (streaming preview + think line + input box + status)
 *     lives at the bottom of the screen. Updated via diff render: compute
 *     the new mutable line array, find the first changed line, move cursor
 *     up to it, clear-to-end, write the new tail.
 */

import chalk from 'chalk';
import cliBoxes from 'cli-boxes';
import { userInfo } from 'node:os';
import { palette, tint } from './theme';
import { styleRabbit, getRecentActivity, formatRelative, FLOPSY_VERSION } from './banner';
import { renderMarkdown } from './components/markdown-renderer';
import { center, fmtElapsed, fmtTok, padRight, stripLen, wrapVisible } from './components/text-utils';
import {
    buildToolDoneLine,
    buildToolDurationLine,
    formatToolResultLines,
    formatToolName,
    argPreview,
    isToolError,
} from './components/tool-display';
import { buildThinkingLines } from './components/thinking-block';
import { renderUserMessage } from './components/user-message';
import { renderSlashHints } from './components/slash-hints';
import { InputHandler } from './input/input-handler';

const ESC = '\x1b';
const write = (s: string): void => { process.stdout.write(s); };
const cols = (): number => process.stdout.columns || 80;

const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ENABLE_BRACKETED = `${ESC}[?2004h`;
const DISABLE_BRACKETED = `${ESC}[?2004l`;
// Kitty keyboard protocol — push flags=1 (disambiguate escape codes,
// report modifier+key) on start, pop on exit. Lets us distinguish
// Shift+Enter from plain Enter (and Ctrl+Enter, Alt+Enter, etc.).
// Silently ignored by terminals that don't speak it.
const ENABLE_KITTY_KEYBOARD = `${ESC}[>1u`;
const DISABLE_KITTY_KEYBOARD = `${ESC}[<u`;
const CLEAR_TO_END = `${ESC}[J`;
const CR = '\r';
const cursorUp = (n: number): string => (n > 0 ? `${ESC}[${n}A` : '');

const THINK_BASE = process.platform === 'darwin'
    ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽'];
const THINK_SPIN = [...THINK_BASE, ...[...THINK_BASE].reverse()];

// Playful gerunds for the working line (claude-code pattern). One is sampled
// per turn so a long reply doesn't read as a frozen "working…".
const THINK_VERBS = [
    'Thinking', 'Working', 'Cogitating', 'Pondering', 'Brewing', 'Reasoning',
    'Crunching', 'Noodling', 'Percolating', 'Mulling', 'Synthesizing',
    'Computing', 'Churning', 'Scheming', 'Conjuring', 'Untangling',
];

export interface ChatTUICallbacks {
    /**
     * `display` keeps any `[Pasted text #N]` placeholders so the TUI can show
     * a collapsed message in chat history. `expanded` substitutes them for
     * the agent. `pastes` is the id→full-text map used to expand placeholders
     * later when the user toggles Ctrl+O. When no paste was collapsed, display
     * === expanded and pastes is empty.
     */
    onSend(payload: { display: string; expanded: string; pastes: Map<number, string> }): void;
    onInterrupt(): void;
    onQuit(): void;
}

export class ChatTUI {
    private input = new InputHandler({
        onSubmit: () => this.submit(),
        onQuit: () => this.cbs.onQuit(),
        onRedraw: () => this.render(),
        onToggleExpand: () => this.toggleExpansion(),
        // Scroll keys are no-ops — terminal native scrollback handles it.
        onPageUp:   () => {},
        onPageDown: () => {},
        // Ctrl+C while a turn is streaming → abort the agent reply
        // without exiting the CLI. setStreaming(false) clears the
        // visual streaming indicator immediately; the gateway side
        // wiring (chat-command.ts) sends `{type: 'interrupt'}` to abort
        // the in-flight LLM call.
        onInterrupt: () => {
            if (this.streaming) {
                this.cbs.onInterrupt();
                this.setStreaming(false);
                this.addAssistantText('_(interrupted by user)_');
            }
        },
        onNotice: (text) => {
            this.addAssistantText(text);
        },
        isStreaming: () => this.streaming,
    });

    // ── rendering core ────────────────────────────────────────────────────

    /** Lines currently rendered in the mutable region (below the watermark). After every render/commit, cursor sits at the END of the last mutable line — never on a row below — so the input box stays pinned to the bottom of the viewport. */
    private mutable: string[] = [];

    /**
     * Committed history blocks. Each block knows how to re-render itself
     * in either collapsed or expanded mode (driven by `expanded` flag).
     * Used by Ctrl+O to repaint the whole conversation with paste blocks
     * toggled between `[Pasted text #N]` placeholders and full content.
     */
    private historyBlocks: Array<(expanded: boolean) => string[]> = [];
    /** Toggled by Ctrl+O. When true, history is re-rendered with pasted text expanded. */
    private expanded = false;

    // ── streaming state ───────────────────────────────────────────────────

    /** In-progress assistant text, raw word-wrapped (re-rendered as markdown on commit). */
    private streamTextBuf = '';
    /** Lines built from streamTextBuf — visible in the mutable region. */
    private streamingLines: string[] = [];

    private thinkBuf = '';
    private thinkingLines: string[] = [];
    private thinkingVisible = true;
    private thinkActive = false;
    private thinkFrame = 0;
    private thinkVerb = 'Working';
    private thinkInterval: ReturnType<typeof setInterval> | null = null;

    /** When set, a tool is in flight. Show the spinner. */
    private activeTool: { name: string; args?: string; startedAt: number } | null = null;
    private toolsExpanded = false;
    private toolFiredThisTurn = false;

    // ── session state ─────────────────────────────────────────────────────

    private streaming = false;
    private threadId = '';
    private model = '';
    private cwd = '';
    private branch = '';
    private tokenIn = 0;
    private tokenOut = 0;
    private tokenReasoning = 0;
    private tokenCached = 0;
    private contextTokens = 0;
    private contextLimit: number | null = null;
    private turnCount = 0;
    private sessionStart = Date.now();
    private responseStartMs = 0;
    private lastResponseMs = 0;

    private clockInterval: ReturnType<typeof setInterval> | null = null;
    /** True once start() has set up the terminal. Guards renders triggered before the TUI is live (e.g. async setBranch). */
    private started = false;

    setContextUsage(used: number, limit: number | null): void {
        this.contextTokens = used;
        this.contextLimit = limit;
        this.render();
    }

    setBranch(branch: string): void {
        this.branch = branch;
        this.render();
    }

    constructor(private readonly cbs: ChatTUICallbacks) {}

    // ── lifecycle ─────────────────────────────────────────────────────────

    start(): void {
        this.started = true;
        this.installConsoleInterceptor();
        write(HIDE_CURSOR);
        write(ENABLE_BRACKETED);
        write(ENABLE_KITTY_KEYBOARD);
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.on('data', (d: Buffer) => this.input.handle(d));
        process.stdout.on('resize', () => this.handleResize());
        this.clockInterval = setInterval(() => this.render(), 1000);
        this.clockInterval.unref();
        // First render draws the input box + status bar at the cursor's
        // current position. Whatever was on screen above stays in scrollback.
        this.render();
    }

    stop(): void {
        this.stopThink();
        if (this.clockInterval !== null) { clearInterval(this.clockInterval); this.clockInterval = null; }
        // Clear the mutable region so the shell prompt has a clean slate.
        if (this.mutable.length > 0) {
            write(cursorUp(this.mutable.length) + CR + CLEAR_TO_END);
            this.mutable = [];
        }
        write(DISABLE_KITTY_KEYBOARD);
        write(DISABLE_BRACKETED);
        write(SHOW_CURSOR);
        try { process.stdin.setRawMode?.(false); } catch { /* */ }
        process.stdin.pause();
        this.restoreConsole();
    }

    private origConsole: { log?: typeof console.log; info?: typeof console.info } = {};

    /**
     * Foreign writers (gateway internals, [FileBridge], [programmatic-tool],
     * [docker-session], etc.) emit console.log which lands on stdout *between*
     * our renders. Without interception, those writes advance the cursor
     * without updating this.mutable, so the next render's cursor math
     * under-counts and the previous mutable region stays visible above the
     * new one — the "doubling" bug.
     *
     * Fix: route console.log/info through commitForeignLog which clears the
     * mutable region first, writes the line into the scrollback area above,
     * then re-renders mutable below. console.warn/error go to stderr and
     * don't affect the TUI, so we leave them alone.
     */
    private installConsoleInterceptor(): void {
        this.origConsole.log = console.log;
        this.origConsole.info = console.info;
        const route = (...args: unknown[]): void => {
            try {
                const text = args
                    .map((a) => typeof a === 'string' ? a : (() => { try { return require('node:util').inspect(a, { depth: 4, colors: false }); } catch { return String(a); } })())
                    .join(' ');
                this.commitForeignLog(text);
            } catch {
                this.origConsole.log?.(...args as Parameters<typeof console.log>);
            }
        };
        console.log = route as typeof console.log;
        console.info = route as typeof console.info;
    }

    private restoreConsole(): void {
        if (this.origConsole.log) console.log = this.origConsole.log;
        if (this.origConsole.info) console.info = this.origConsole.info;
        this.origConsole = {};
    }

    private commitForeignLog(text: string): void {
        if (!this.started) {
            this.origConsole.log?.(text);
            return;
        }
        if (this.mutable.length > 0) {
            write(cursorUp(this.mutable.length - 1) + CR + CLEAR_TO_END);
        } else {
            write(CR + CLEAR_TO_END);
        }
        write(text + '\n');
        this.mutable = [];
        this.render();
    }

    private handleResize(): void {
        // Force a full re-render — line widths changed.
        this.mutable = [];
        write(CLEAR_TO_END);
        this.render();
    }

    // ── public API ────────────────────────────────────────────────────────

    showWelcome(threadId: string, model: string): void {
        this.threadId = threadId;
        this.model = model;

        const c = cols();
        // Cap the banner at 80 cols regardless of terminal width — same idea
        // as claude-code's WELCOME_V2_WIDTH (58). On wide terminals the box
        // stays tight rather than stretching the dual-column layout out.
        const boxWidth = Math.min(c, 80);
        const leftPad = Math.max(0, Math.floor((c - boxWidth) / 2));
        const indent = ' '.repeat(leftPad);

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
        const leftW = Math.floor(innerW * 0.4);
        const rightW = innerW - leftW - 3; // 3 = " │ " separator

        const titleInline = ` ${tint.brand.bold('FlopsyBot')} ${chalk.dim('v' + FLOPSY_VERSION)} `;
        const titleVis = stripLen(titleInline);
        const leftDashes = 3;
        const rightDashes = Math.max(1, innerW - titleVis - leftDashes);
        const topBar = pb(box.topLeft) + pb(box.top.repeat(leftDashes)) +
            titleInline + pb(box.top.repeat(rightDashes)) + pb(box.topRight);
        const botBar = pb(box.bottomLeft) + pb(box.bottom.repeat(innerW)) + pb(box.bottomRight);

        const truncatePlain = (s: string, w: number): string =>
            stripLen(s) <= w ? s : s.slice(0, w - 1) + '…';

        const leftLines = [
            center(chalk.bold(`Welcome back ${name}!`), leftW),
            ...rabbit.map((r) => center(r, leftW)),
            center(chalk.italic.dim('a little rabbit, a lot of tools'), leftW),
            center(chalk.dim(truncatePlain(cwdShort, leftW)), leftW),
        ];

        const tips: ReadonlyArray<readonly [string, string]> = [
            ['/help', 'commands'], ['/new', 'fresh session'],
            ['/compact', 'free context'], ['/status', 'gateway'],
        ];
        const renderTip = (cmd: string, what: string): string => {
            const line = ` ${blue(cmd)} ${dim('—')} ${what}`;
            return truncatePlain(line, rightW);
        };

        const activity = getRecentActivity(2);
        const activityLines = activity.length === 0
            ? [dim(' no recent activity')]
            : activity.map(({ label, mtimeMs }) => {
                const rel = formatRelative(mtimeMs);
                return truncatePlain(` ${label} ${dim('· ' + rel)}`, rightW);
            });

        const dash = dim('─'.repeat(Math.max(6, rightW)));
        const rightLines = [
            chalk.bold('Tips'),
            ...tips.map(([cmd, what]) => renderTip(cmd, what)),
            dash,
            chalk.bold('Recent'),
            ...activityLines,
        ];

        // Pad each cell to the exact column width using stripLen-aware padRight
        // so ANSI codes don't throw off alignment, then assemble.
        const numRows = Math.max(leftLines.length, rightLines.length);
        const banner: string[] = [];
        banner.push(indent + topBar);
        for (let i = 0; i < numRows; i++) {
            const l = padRight(leftLines[i] ?? '', leftW);
            const r = padRight(rightLines[i] ?? '', rightW);
            banner.push(indent + pb(box.left) + l + dim(' │ ') + r + pb(box.right));
        }
        banner.push(indent + botBar);
        this.commit(banner);
    }

    setCwd(path: string): void { this.cwd = path; }

    setTokens(input: number, output: number, reasoning?: number, cached?: number): void {
        // Gateway sends per-turn absolute usage. Assigning (not accumulating)
        // keeps the status bar in sync with the actual current-turn cost so it
        // matches `ctx` and never runs away across turns.
        this.tokenIn = input;
        this.tokenOut = output;
        this.tokenReasoning = reasoning ?? 0;
        this.tokenCached = cached ?? 0;
        this.render();
    }

    setStreaming(v: boolean): void {
        this.streaming = v;
        if (v) {
            this.responseStartMs = Date.now();
            this.lastResponseMs = 0;
            this.toolFiredThisTurn = false;
            this.thinkVerb = THINK_VERBS[Math.floor(Math.random() * THINK_VERBS.length)]!;
            // Spinner runs for the WHOLE turn (thinking, tool calls, generation)
            // so the user always sees liveness — not just during reasoning text.
            this.startSpinner();
        } else {
            this.lastResponseMs = Date.now() - this.responseStartMs;
            this.activeTool = null;
            this.stopThink();
        }
        this.render();
    }

    /**
     * Display the user's message. `display` may contain `[Pasted text #N +K lines]`
     * placeholders which can be expanded/collapsed via Ctrl+O. The mapping
     * from placeholder → full text is stored in `pasteContents` so a future
     * repaint can render the expanded form.
     */
    addUserMessage(display: string, pasteContents?: ReadonlyMap<number, string>): void {
        const pastes = pasteContents ?? new Map<number, string>();
        const block = (expanded: boolean): string[] => {
            const text = expanded
                ? display.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (m, idStr) => {
                    const id = parseInt(idStr, 10);
                    return pastes.get(id) ?? m;
                })
                : display;
            return renderUserMessage(text, cols());
        };
        this.historyBlocks.push(block);
        this.commit(block(this.expanded), /* track */ false);
    }

    streamThinking(text: string): void {
        if (!text) return;
        this.thinkBuf += text;
        this.thinkingLines = buildThinkingLines(this.thinkBuf, cols(), this.thinkingVisible);
        this.render();
    }

    flushThinking(): void {
        if (this.thinkingLines.length > 0) {
            // Commit thinking block to history.
            this.commit([...this.thinkingLines, '']);
        }
        this.thinkBuf = '';
        this.thinkingLines = [];
    }

    addToolStart(name: string, args?: string): void {
        // Commit any in-flight streamed text BEFORE this tool starts, so
        // scrollback order (text → tool → text) is preserved.
        this.flushThinking();
        this.commitStreamingText();
        this.activeTool = { name, args, startedAt: Date.now() };
        this.toolFiredThisTurn = true;
        // The running tool renders in the mutable region (one animated line
        // that becomes a committed "done" line). It is deliberately NOT
        // committed here — committing both a start and a done line is what
        // previously double-printed the tool name.
        this.render();
    }

    addToolDone(name: string, durationMs: number, result?: string): void {
        const startedArgs = this.activeTool?.args;
        this.activeTool = null;
        const err = isToolError(result);
        // Render as an expandable history block: collapsed by default (6-line
        // cap + "ctrl+o to expand"), full when the user toggles Ctrl+O. This is
        // why the hint is truthful — toggleExpansion repaints this block.
        const block = (expanded: boolean): string[] => {
            const out: string[] = [buildToolDoneLine(name, startedArgs, err)];
            if (result?.trim()) {
                for (const l of formatToolResultLines(result, cols(), err, expanded)) out.push(l);
            }
            out.push(buildToolDurationLine(durationMs));
            out.push('');
            return out;
        };
        this.historyBlocks.push(block);
        // The single, finished tool entry. The spinner keeps running for the
        // rest of the turn, so liveness never blinks out between tools.
        this.commit(block(this.expanded), /* track */ false);
        if (this.streaming && this.thinkInterval === null) this.startSpinner();
        this.render();
    }

    streamAssistantDelta(delta: string): void {
        if (!delta) return;
        this.flushThinking();
        this.streamTextBuf += delta;
        this.streamingLines = this.renderStreamingText(this.streamTextBuf);
        this.render();
    }

    private renderStreamingText(buf: string): string[] {
        const w = Math.max(40, cols() - 4);
        const out: string[] = [];
        for (const line of buf.split('\n')) {
            for (const wl of wrapVisible(line, w)) out.push('  ' + wl);
        }
        return out;
    }

    /** Commit the in-flight streaming text into history (raw word-wrap). */
    private commitStreamingText(): void {
        if (this.streamingLines.length === 0) return;
        this.commit(this.streamingLines);
        this.streamTextBuf = '';
        this.streamingLines = [];
    }

    addAssistantText(text: string): void {
        if (!text) return;
        this.flushThinking();
        this.turnCount++;

        // When tools fired during the turn, the streamed raw text is already
        // committed in the correct positions (interleaved with tool calls).
        // Re-rendering the full accumulated text as markdown here would
        // duplicate everything. Just commit a trailing blank line.
        if (this.toolFiredThisTurn) {
            this.commitStreamingText();
            this.commit(['']);
            return;
        }

        // Tool-free turn: replace the raw streaming preview with rendered
        // markdown by committing the markdown lines (the raw preview was
        // mutable, never committed, so just drop it).
        this.streamTextBuf = '';
        this.streamingLines = [];
        const finalLines = renderMarkdown(text, cols());
        this.commit(['', ...finalLines, '']);
    }

    addError(msg: string): void {
        this.activeTool = null;
        this.stopThink();
        this.commit(['', `  ${chalk.red('✗')} ${chalk.red(msg)}`, '']);
    }

    /** Surface an auto-compaction event in scrollback + refresh the ctx figure. */
    addCompaction(e: { tokensBefore: number; tokensAfter: number; durationMs: number; strategy: string }): void {
        const dim = chalk.hex(palette.muted);
        const sym = chalk.hex(palette.brand)('✦');
        const dur = e.durationMs >= 1000 ? `${(e.durationMs / 1000).toFixed(1)}s` : `${e.durationMs}ms`;
        const freed = Math.max(0, e.tokensBefore - e.tokensAfter);
        this.commit([
            '',
            `  ${sym} ` + dim(`compacted context · ${fmtTok(e.tokensBefore)} → ${fmtTok(e.tokensAfter)} tokens (freed ${fmtTok(freed)}) · ${e.strategy} · ${dur}`),
            '',
        ]);
        // Reflect freed context in the status bar right away.
        this.setContextUsage(e.tokensAfter, this.contextLimit);
    }

    addTaskEvent(kind: 'start' | 'progress' | 'complete' | 'error', taskId: string, info?: string): void {
        const dim = chalk.hex(palette.muted);
        const tag = dim(`task #${taskId}`);
        const detail = info ? ' · ' + dim(info.length > 80 ? info.slice(0, 79) + '…' : info) : '';
        let line: string;
        switch (kind) {
            case 'start':    line = `  ${chalk.cyan('◇')} ${tag} ${dim('started')}${detail}`; break;
            case 'progress': line = `  ${dim('·')} ${tag}${detail}`; break;
            case 'complete': line = `  ${chalk.hex(palette.success)('◆')} ${tag} ${dim('done')}${detail}`; break;
            case 'error':    line = `  ${chalk.red('✗')} ${tag} ${chalk.red('failed')}${detail}`; break;
        }
        this.commit([line]);
    }

    /** Reset all streaming/intermediate state — called on disconnect to avoid stale spinners. */
    resetState(): void {
        this.stopThink();
        this.streaming = false;
        this.thinkBuf = '';
        this.thinkingLines = [];
        this.streamTextBuf = '';
        this.streamingLines = [];
        this.activeTool = null;
        this.render();
    }

    /** Clear the screen for /clear or /new. */
    clear(): void {
        this.activeTool = null;
        this.turnCount = 0;
        this.thinkBuf = '';
        this.thinkingLines = [];
        this.streamTextBuf = '';
        this.streamingLines = [];
        // ESC[2J ESC[3J ESC[H — clear screen, scrollback, home.
        write(`${ESC}[2J${ESC}[3J${ESC}[H`);
        this.mutable = [];
        this.render();
    }

    // ── core rendering ────────────────────────────────────────────────────

    /**
     * Append `lines` into the terminal's native scrollback (committed history).
     * Also records the lines as a static history block so a Ctrl+O repaint can
     * reproduce them. Static blocks render the same lines regardless of the
     * `expanded` flag — only paste-aware blocks like user messages override.
     * Lifts the mutable region first so the new history lines slot above it.
     * After: cursor at end of the last mutable line, input pinned to bottom.
     */
    private commit(lines: string[], track = true): void {
        if (lines.length === 0) {
            this.render();
            return;
        }
        if (track) {
            // Snapshot for repaint. The lines are already rendered for the
            // current state; same value works for both expanded/collapsed.
            const snapshot = [...lines];
            this.historyBlocks.push(() => snapshot);
        }
        if (this.mutable.length > 0) {
            write(cursorUp(this.mutable.length - 1) + CR + CLEAR_TO_END);
        } else {
            write(CR + CLEAR_TO_END);
        }
        for (const line of lines) write(line + '\n');
        this.mutable = [];
        this.render();
    }

    /**
     * Diff-render the mutable region. The invariant is that after every
     * render or commit, cursor sits at the END of the last mutable line —
     * never on a fresh row below. This keeps the input box pinned to the
     * bottom of the viewport instead of leaving an empty trailing row.
     */
    private render(): void {
        if (!this.started) return;
        const newMutable = this.buildMutable();

        let firstChanged = 0;
        const minLen = Math.min(this.mutable.length, newMutable.length);
        while (firstChanged < minLen && this.mutable[firstChanged] === newMutable[firstChanged]) {
            firstChanged++;
        }

        // No change at all.
        if (firstChanged === this.mutable.length && firstChanged === newMutable.length) return;

        if (this.mutable.length === 0) {
            // First-ever render: just write the new mutable, joined by \n.
            write(newMutable.join('\n'));
        } else {
            // Cursor is at end of mutable's last line. To start of `firstChanged`:
            // up (mutable.length - 1 - firstChanged) rows + \r.
            const linesToGoUp = (this.mutable.length - 1) - firstChanged;
            write(cursorUp(linesToGoUp) + CR + CLEAR_TO_END);
            // Write the changed tail. Join by \n with no trailing \n so the
            // cursor lands at the end of the last line, not a fresh row.
            write(newMutable.slice(firstChanged).join('\n'));
        }
        this.mutable = newMutable;
    }

    /**
     * Build the mutable region: streaming preview + think + input + status.
     *
     * Caps the variable-height portion (streaming + thinking) to whatever
     * fits in the viewport above the chrome (input box + status). Without
     * this cap, when the streaming preview grows taller than the terminal,
     * the older preview rows AND the chrome rendered between them scroll
     * past the top of the viewport into scrollback — permanently
     * contaminating the saved chat history with input boxes, spinners,
     * and status lines wedged between messages.
     *
     * The full streaming text is still preserved in `this.streamingLines`
     * — only the on-screen preview is truncated. When the turn finishes,
     * `commitStreamingText()` writes the complete buffer to history.
     */
    private buildMutable(): string[] {
        const out: string[] = [];

        // Reserve rows for the chrome that always sits at the bottom of the
        // mutable region. Sized to cover the worst-case footprint:
        //   blank spacer (1) + thinkLine (1) + input top border (1) +
        //   input content (≥1) + input bottom border (1) + slash hints
        //   (≤2) + statusBar line1 + line2 = 8-10 rows.
        // Capping at 10 with a `Math.max(3, …)` floor ensures even a 13-row
        // terminal still shows 3 streaming rows above the chrome.
        const termRows = process.stdout.rows ?? 24;
        const CHROME_RESERVE = 10;
        const previewBudget = Math.max(3, termRows - CHROME_RESERVE);

        const totalVariable = this.streamingLines.length + this.thinkingLines.length;
        let streamSlice: readonly string[] = this.streamingLines;
        let thinkSlice: readonly string[] = this.thinkingLines;

        if (totalVariable > previewBudget) {
            // Favour the most recent streaming text. Cap thinking lines to
            // ⅓ of the budget — they're usually short summaries that
            // shouldn't dominate the viewport when active tools are
            // narrating heavy output.
            const thinkAllowed = Math.min(
                this.thinkingLines.length,
                Math.max(1, Math.floor(previewBudget / 3)),
            );
            thinkSlice = this.thinkingLines.slice(-thinkAllowed);
            const streamAllowed = Math.max(1, previewBudget - thinkAllowed);
            streamSlice = this.streamingLines.slice(-streamAllowed);

            const elided =
                (this.streamingLines.length - streamSlice.length) +
                (this.thinkingLines.length - thinkSlice.length);
            if (elided > 0) {
                const dim = (s: string) => chalk.hex(palette.muted)(s);
                out.push(dim(`  …${elided} earlier line${elided === 1 ? '' : 's'} (full text will appear in scrollback when complete)`));
            }
        }

        for (const l of streamSlice) out.push(l);
        for (const l of thinkSlice) out.push(l);
        if (streamSlice.length > 0 || thinkSlice.length > 0) {
            out.push('');
        }
        // Show the live working line for the WHOLE turn (thinking, tool calls,
        // and generation) — not just while reasoning text streams — so the user
        // is never left wondering whether the agent is still working.
        if (this.streaming || this.activeTool) {
            out.push(this.thinkLine());
        } else {
            out.push('');
        }
        for (const l of this.buildInputRegion()) out.push(l);
        const status = this.buildStatusBar(cols());
        out.push(status.line1);
        out.push(status.line2);
        return out;
    }

    private buildInputRegion(): string[] {
        const dim = (s: string) => chalk.hex(palette.muted)(s);
        const c = cols();
        const lines: string[] = [];
        const boxW = Math.max(40, c - 4);
        const leftPad = Math.max(0, Math.floor((c - boxW) / 2));
        const pw = (s: string) => ' '.repeat(leftPad) + s;

        lines.push(pw(dim('┌' + '─'.repeat(boxW) + '┐')));
        for (const il of this.input.renderInputLines(boxW)) {
            const visLen = stripLen(il);
            const padding = ' '.repeat(Math.max(0, boxW - visLen));
            lines.push(pw(dim('│') + il + padding + dim('│')));
        }
        lines.push(pw(dim('└' + '─'.repeat(boxW) + '┘')));
        for (const h of renderSlashHints(this.input.state.buf, this.input.state.slashHintIdx, c)) lines.push(h);
        return lines;
    }

    private buildStatusBar(c: number): { line1: string; line2: string } {
        const dim = (s: string) => chalk.hex(palette.muted)(s);
        const w = Math.max(1, c);

        const home = process.env['HOME'] ?? '';
        const cwdDisp = this.cwd ? this.cwd.replace(home, '~') : '';
        const branch = this.branch;

        const left1 = dim(cwdDisp + (branch ? ' ' + chalk.hex(palette.channel)(branch) : ''));
        const rightParts1: string[] = [];
        if (this.turnCount > 0) rightParts1.push(dim(`Σ ${this.turnCount}`));
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

        const rightParts2: string[] = [];
        const tokenParts = [`↑${fmtTok(this.tokenIn)} ↓${fmtTok(this.tokenOut)}`];
        if (this.tokenReasoning > 0) tokenParts.push(`✦${fmtTok(this.tokenReasoning)}`);
        if (this.tokenCached > 0) tokenParts.push(`◆${fmtTok(this.tokenCached)}`);
        rightParts2.push(dim(tokenParts.join(' ')));
        if (this.contextTokens > 0) {
            rightParts2.push(this.renderContextBar());
        }
        const line2 = rightParts2.join('  ');

        return { line1, line2 };
    }

    /**
     * Render the context-usage indicator as a compact progress bar.
     *
     * Replaces the prior "ctx 554.3K / ⚠ ctx filling" duplicate-numeric form
     * with a Hermes-style visual bar that shows how full the window is at a
     * glance. Colour tiers: dim ≤60%, neutral 60–80%, warn 80–95%, red ≥95%.
     * Bar is omitted when the model's window limit isn't known (no
     * denominator) — falls back to bare token count + warn marker.
     */
    private renderContextBar(): string {
        const used = this.contextTokens;
        const limit = this.contextLimit && this.contextLimit > 0 ? this.contextLimit : null;
        const dim = (s: string) => chalk.hex(palette.muted)(s);

        if (!limit) {
            const overflowMark = used >= 80_000 ? ' ' + chalk.hex(palette.warn)('⚠') : '';
            return dim(`ctx ${fmtTok(used)}`) + overflowMark;
        }

        const pct = Math.max(0, Math.min(1, used / limit));
        const pctNum = Math.round(pct * 100);

        const BAR_WIDTH = 14;
        const filled = Math.min(BAR_WIDTH, Math.max(0, Math.round(pct * BAR_WIDTH)));
        const empty = BAR_WIDTH - filled;

        const colour =
            pct >= 0.95 ? (s: string) => chalk.red(s)
            : pct >= 0.80 ? (s: string) => chalk.hex(palette.warn)(s)
            : pct >= 0.60 ? (s: string) => s
            : dim;

        const bar = colour('█'.repeat(filled)) + dim('░'.repeat(empty));
        const pctTxt = colour(`${pctNum}%`.padStart(4));
        const sizeTxt = dim(`${fmtTok(used)}/${fmtTok(limit)}`);
        return `${bar} ${pctTxt} ${sizeTxt}`;
    }

    /** Start the per-turn spinner (idempotent). Runs through thinking, tools, and generation. */
    private startSpinner(): void {
        this.stopThink();
        this.thinkActive = true;
        this.thinkFrame = 0;
        this.thinkInterval = setInterval(() => {
            this.thinkFrame = (this.thinkFrame + 1) % THINK_SPIN.length;
            this.render();
        }, 160);
    }

    private thinkLine(): string {
        const sym = chalk.hex('#D77757')(THINK_SPIN[this.thinkFrame % THINK_SPIN.length]!);
        const dim = chalk.hex(palette.muted);
        const elapsed = this.responseStartMs > 0 ? fmtElapsed(Date.now() - this.responseStartMs) : '';
        // Live output-token estimate (~4 chars/token) over the text streamed so
        // far this turn; the status bar shows the exact count on completion.
        const genChars = this.streamTextBuf.length + this.thinkBuf.length;
        const tokEst = Math.floor(genChars / 4);
        const tok = tokEst > 0 ? `↓ ${fmtTok(tokEst)} tok` : '';
        // While a tool runs, show the tool name (not a generic verb) so the
        // single mutable line reads as "this exact tool is in flight".
        if (this.activeTool) {
            const display = formatToolName(this.activeTool.name);
            const preview = this.activeTool.args ? argPreview(this.activeTool.args) : '';
            const head = preview ? `${chalk.bold(display)}${dim('(' + preview + ')')}` : chalk.bold(display);
            const meta = [elapsed, 'esc to interrupt'].filter(Boolean).join(' · ');
            return `  ${sym} ` + head + dim(`  (${meta})`);
        }
        const meta = [elapsed, tok, 'esc to interrupt'].filter(Boolean).join(' · ');
        return `  ${sym} ` + dim.italic(`${this.thinkVerb}…`) + dim(`  (${meta})`);
    }

    /**
     * Toggle paste-block expansion (Ctrl+O). Wipes the screen + scrollback
     * and re-emits every committed history block in the new mode. Native
     * scrollback can't be edited in place, so a full repaint is the only
     * way to flip already-committed `[Pasted text #N]` placeholders to/from
     * their full content.
     */
    toggleExpansion(): void {
        this.expanded = !this.expanded;
        this.toolsExpanded = this.expanded;
        // ESC[2J ESC[3J ESC[H — clear viewport, clear scrollback, home cursor.
        write(`${ESC}[2J${ESC}[3J${ESC}[H`);
        this.mutable = [];
        for (const block of this.historyBlocks) {
            for (const line of block(this.expanded)) write(line + '\n');
        }
        this.render();
    }

    private submit(): void {
        const { display, expanded, pastes } = this.input.consume();
        if (!expanded) return;
        if (expanded === '/exit' || expanded === '/quit' || expanded === '/q') {
            this.cbs.onQuit();
            return;
        }
        // Sending a message while a turn streams does NOT interrupt it — the
        // message is queued and the gateway injects it mid-turn (or runs it as
        // the next turn). This mirrors Claude: typing QUEUES, esc/Ctrl+C STOPS.
        // Previously a follow-up implicitly aborted the turn, so users who
        // typed while the agent worked saw it "stop suddenly".
        this.render();
        this.cbs.onSend({ display, expanded, pastes });
    }

    private stopThink(): void {
        if (this.thinkInterval !== null) { clearInterval(this.thinkInterval); this.thinkInterval = null; }
        this.thinkActive = false;
    }
}
