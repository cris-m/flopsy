import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import cliBoxes from 'cli-boxes';
import { userInfo } from 'node:os';
import { palette, tint } from './theme';
import { styleRabbit, getRecentActivity, formatRelative } from './banner';

/**
 * ChatTUI — terminal chat client for `flopsy chat`.
 *
 * Layout (alt-screen, Claude Code-style):
 *
 *   ┌──────────────────────────────────────────┐
 *   │  banner appears here ONCE at start, then │  ← scroll region (top..R-inputH)
 *   │  scrolls up naturally as new content     │     entire area above input —
 *   │  arrives — same as any chat line. NOT    │     no pinned banner.
 *   │  pinned.                                 │
 *   │                                          │
 *   │ Chat lines (user, assistant, tools,      │
 *   │ tasks, thinking) accumulate at the       │
 *   │ bottom of the region; oldest scrolls off │
 *   │ the top of the region.                   │
 *   ├──────────────────────────────────────────┤  ← input region (PINNED, bottom)
 *   │ ✻ thinking… / ⠹ tool…                    │
 *   │ ─ ✦ │ model │ Σ N │ time ─               │
 *   │ /cmd hint popup (when typing slash)      │
 *   │  › multi-line input ▍                    │
 *   └──────────────────────────────────────────┘
 *
 *   • Banner pushed into chatLog by showWelcome() like any other content.
 *   • Chat content stored in `chatLog: string[]`; `repaintScrollRegion()`
 *     paints the bottom N visible entries on every change so content
 *     survives input-region resize (think spinner, slash hint, etc.).
 *   • Tool calls: ONE mutable line per call. White `●` while running →
 *     replaced in place by green `●` + duration + ✓ on completion. Optional
 *     truncated result preview line below ("⏎ result snippet…").
 *   • Thinking text rendered in scrollback as gray italic, prefixed `✻`,
 *     accumulated chunks append to the same block.
 *   • Input region is rebuilt + repainted on every keystroke using absolute
 *     positioning so it always sits at the bottom.
 *   • Multi-line input via Alt+Enter or Ctrl+J; Enter submits.
 *   • Slash commands: typing `/` opens inline hint popup; `/exit` quits.
 */

const ESC = '\x1b';
const write = (s: string): void => { process.stdout.write(s); };
const cols  = (): number => process.stdout.columns || 80;

const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_SCREEN = `${ESC}[2J`;
const ENABLE_BRACKETED  = `${ESC}[?2004h`;
const DISABLE_BRACKETED = `${ESC}[?2004l`;
const ENTER_ALT_SCREEN  = `${ESC}[?1049h`;
const LEAVE_ALT_SCREEN  = `${ESC}[?1049l`;
const RESET_SCROLL_REGION = `${ESC}[r`;
const moveTo = (row: number, col: number): string => `${ESC}[${row};${col}H`;
const clearLine = `${ESC}[2K`;

// Spinner frames
const TOOL_SPIN = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

// Think-spinner — Claude Code's `·` → `✢` → `✳` → `✶` → `✻` → `✽` progression
// (Spinner/utils.ts). Played forward then reversed for a smooth ping-pong feel.
// Platform-specific tail: macOS uses `✽`, Linux uses `*`.
const THINK_BASE = process.platform === 'darwin'
    ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽'];
const THINK_SPIN = [...THINK_BASE, ...[...THINK_BASE].reverse()];

// Block-cursor character rendered inside the input string at cursor position.
const CURSOR_BLOCK = '▍';

/**
 * Hardcoded slash-command hint list. Mirrors the gateway's built-in
 * commands at src/gateway/src/commands/registry.ts. Skill commands are
 * dynamic; for those we'd need a /commands list endpoint over WS — out
 * of scope for now, the user just types them blind.
 */
interface SlashCmd {
    readonly name: string;
    readonly description: string;
    readonly argHint?: string;
}

const SLASH_COMMANDS: readonly SlashCmd[] = [
    { name: 'new',         description: 'start a fresh session, keep facts + prefs' },
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

export interface ChatTUICallbacks {
    onSend(text: string): void;
    onInterrupt(): void;
    onQuit(): void;
}

export class ChatTUI {
    // ── input state ───────────────────────────────────────────────────────
    private inputBuf = '';   // can contain '\n' for multi-line
    private slashHintIdx = 0;  // highlighted index in the slash-hint popup; reset on input change
    private scrollOffset = 0;  // 0 = at bottom (live); >0 = scrolled up by N lines
    private unreadSince = 0;   // chatLog length when user scrolled up; tracks new lines arrived since
    private inputPos = 0;    // char index into inputBuf
    private history: string[] = [];
    private histIdx  = -1;
    private histTmp  = '';

    // ── transient streaming state ─────────────────────────────────────────
    private streaming = false;
    private threadId  = '';
    private model     = '';

    private thinkActive   = false;
    private thinkFrame    = 0;
    private thinkInterval: ReturnType<typeof setInterval> | null = null;

    private activeTool:    { name: string; args?: string; startedAt: number; frame: number } | null = null;
    private toolInterval:  ReturnType<typeof setInterval> | null = null;
    // Index of the active tool's line in chatLog so addToolDone can
    // mutate that exact slot (instead of appending a second line).
    private activeToolLogIndex: number | null = null;
    // Active thinking-block bookkeeping. We accumulate the raw text and
    // re-wrap the whole buffer on every chunk so streaming tokens flow
    // as a paragraph instead of one chunk per line.
    private thinkBuf = '';
    private thinkStartIndex: number | null = null;
    private thinkLineCount = 0;

    // ── session counters ──────────────────────────────────────────────────
    private sessionStart = Date.now();
    private turnCount    = 0;

    // ── layout tracking ───────────────────────────────────────────────────
    // Pinned banner lines (rendered at top of screen, outside scroll region).
    private bannerLines: string[] = [];
    private bannerHeight = 0;
    // Number of rows the input region (spinner + status + hint + input) uses.
    private lastInputH = 1;
    // Internal log of every chat scrollback line written. The scroll region
    // is repainted from this whenever its size changes (think spinner appears,
    // slash hint expands, etc.) so the most recent content survives input-
    // region growth — without this, recent rows get painted over.
    private chatLog: string[] = [];
    private static readonly CHAT_LOG_MAX = 1000;

    // Bracketed-paste accumulation: when a paste starts we accumulate raw
    // bytes until \x1b[201~, then commit as one chunk (with embedded \n's).
    // Watchdog timer commits whatever we have if the END marker never
    // arrives within `PASTE_TIMEOUT_MS`, preventing the user from getting
    // stuck if the terminal misbehaves.
    private pasteBuf:    string | null = null;
    private pasteTimer:  ReturnType<typeof setTimeout> | null = null;
    private static readonly PASTE_TIMEOUT_MS = 500;

    constructor(private readonly cbs: ChatTUICallbacks) {}

    // ── lifecycle ─────────────────────────────────────────────────────────

    start(): void {
        // Alt-screen so we own the full viewport: banner pinned at top,
        // chat scrolls in the middle, input pinned at the bottom. Previous
        // shell output is preserved — restored when we exit.
        write(ENTER_ALT_SCREEN);
        write(HIDE_CURSOR);
        write(ENABLE_BRACKETED);
        write(CLEAR_SCREEN);

        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.on('data', (d: Buffer) => this.onKey(d));
        process.stdout.on('resize', () => this.repaintAll());
        this.repaintAll();
    }

    stop(): void {
        this.stopTool();
        this.stopThink();
        this.clearPasteTimeout();
        write(RESET_SCROLL_REGION);
        write(DISABLE_BRACKETED);
        write(SHOW_CURSOR);
        write(LEAVE_ALT_SCREEN);
        try { process.stdin.setRawMode?.(false); } catch { /**/ }
        process.stdin.pause();
    }

    // ── public API ────────────────────────────────────────────────────────

    showWelcome(threadId: string, model: string): void {
        this.threadId = threadId;
        this.model    = model;

        const c        = cols();
        const boxWidth = Math.min(c - 2, 110);
        const box      = cliBoxes.round;
        const pb       = (s: string) => chalk.hex(palette.brand)(s);
        const dim      = (s: string) => chalk.hex(palette.muted)(s);
        const blue     = (s: string) => chalk.hex(palette.channel)(s);

        const rabbit = styleRabbit(true).split('\n').filter((l) => l.trim().length > 0);
        const name   = (() => { try { return userInfo().username; } catch { return 'local'; } })();
        const cwdAbs = process.cwd();
        const home   = process.env['HOME'] ?? '';
        const cwd    = home && cwdAbs.startsWith(home) ? '~' + cwdAbs.slice(home.length) : cwdAbs;

        const innerW = boxWidth - 2;
        const leftW  = Math.max(28, Math.floor(innerW * 0.42));
        const rightW = innerW - leftW - 5;

        // Title bar: ╭─── FlopsyBot v1.0.0 ─────╮ — embedded title like the
        // top-level CLI banner so the chat splash reads as "the same product".
        const titleInline = ` ${tint.brand.bold('FlopsyBot')} ${chalk.dim('v1.0.0')} `;
        const titleVis    = stripAnsi(titleInline).length;
        const leftDashes  = 3;
        const rightDashes = Math.max(1, innerW - titleVis - leftDashes);
        const topBar = pb(box.topLeft) +
            pb(box.top.repeat(leftDashes)) +
            titleInline +
            pb(box.top.repeat(rightDashes)) +
            pb(box.topRight);
        const botBar = pb(box.bottomLeft) + pb(box.bottom.repeat(innerW)) + pb(box.bottomRight);

        const truncatePlain = (s: string, w: number): string =>
            stripAnsi(s).length <= w ? s : s.slice(0, w - 1) + '…';

        const cwdTrim = truncatePlain(cwd, leftW);

        const leftLines: string[] = [
            '',
            center(chalk.bold(`Welcome back ${name}!`), leftW),
            '',
            ...rabbit.map((r) => center(r, leftW)),
            '',
            center(`${tint.brand.bold('FlopsyBot')} ${chalk.dim('v1.0.0')}`, leftW),
            center(chalk.italic.dim('a little rabbit, a lot of tools'), leftW),
            '',
            center(chalk.dim(cwdTrim), leftW),
            '',
        ];

        const tips: ReadonlyArray<readonly [string, string]> = [
            ['/help',    'list commands'],
            ['/new',     'start a fresh session'],
            ['/compact', 'summarise + free context'],
            ['/status',  'gateway snapshot'],
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
                const raw = ` • ${label} ${dim('—')} ${rel}`;
                return truncatePlain(raw, rightW);
            });

        const dash = dim('─'.repeat(Math.max(6, rightW)));

        const rightLines: string[] = [
            '',
            chalk.bold('Tips for getting started'),
            ...tips.map(([cmd, what]) => renderTip(cmd, what)),
            '',
            dash,
            '',
            chalk.bold('Recent activity'),
            ...activityLines,
            '',
        ];

        const numRows = Math.max(leftLines.length, rightLines.length);

        // Banner goes into the chat log just like any other content —
        // Claude Code's pattern: shown ONCE at the top of the conversation,
        // scrolls up naturally as new chat content arrives. The banner is
        // NOT pinned. Input remains pinned at the bottom (DECSTBM region).
        this.scrollbackLine('');
        this.scrollbackLine(' ' + topBar);
        for (let i = 0; i < numRows; i++) {
            const l = padRight(leftLines[i]  ?? '', leftW);
            const r = padRight(rightLines[i] ?? '', rightW);
            this.scrollbackLine(` ${pb(box.left)} ${l} ${dim('│')} ${r} ${pb(box.right)}`);
        }
        this.scrollbackLine(' ' + botBar);
        this.scrollbackLine('');
    }

    setStreaming(v: boolean): void {
        this.streaming = v;
        if (v) {
            // Clear any existing think interval — stops a leak when the
            // user submits a second message before the first turn finishes.
            this.stopThink();
            this.thinkActive = true;
            this.thinkFrame  = 0;
            this.thinkInterval = setInterval(() => {
                this.thinkFrame = (this.thinkFrame + 1) % THINK_SPIN.length;
                this.redraw();
            }, 160);
        } else {
            this.stopThink();
            this.stopTool();
        }
        this.redraw();
    }

    addUserMessage(text: string): void {
        // Claude Code style: text on a gray block, no "you" label.
        // Mirrors `userMessageBackground` from src/utils/theme.ts which is
        // `ansi:blackBright` on the dark theme — a medium gray that stays
        // readable for white foreground.
        const c = cols();
        const innerW = Math.max(20, c - 4);
        this.scrollbackLine('');
        for (const raw of text.split('\n')) {
            for (const wrapped of wrapVisible(raw, innerW)) {
                const visLen = stripAnsi(wrapped).length;
                const padded = wrapped + ' '.repeat(Math.max(0, innerW - visLen));
                this.scrollbackLine('  ' + chalk.bgBlackBright.white(' ' + padded + ' '));
            }
        }
        this.redraw();
    }

    /**
     * Render extended-reasoning ("thinking") text in scrollback, in
     * gray italic. Multiple consecutive chunks append to the SAME
     * scrollback entry (mutate in place + repaint) instead of producing
     * one log line per chunk — chunks arrive char-by-char from the model
     * stream and would otherwise blow up the chat log.
     */
    streamThinking(text: string): void {
        if (!text) return;

        if (this.thinkStartIndex === null) {
            // Open a new thinking block — anchor at the current end of chatLog.
            this.thinkBuf = text;
            this.thinkStartIndex = this.chatLog.length;
            this.thinkLineCount = 0;
        } else {
            // Continuation — append raw text to the running buffer.
            this.thinkBuf += text;
        }

        this.renderThinkingBlock();
    }

    /**
     * Re-wrap the entire thinking buffer on every chunk, then splice the
     * fresh lines into chatLog at the block's anchor. Streaming tokens
     * thus flow as a paragraph that grows in place — matches Claude Code's
     * thinking display, avoids the "one chunk per line" bug.
     */
    private renderThinkingBlock(): void {
        if (this.thinkStartIndex === null) return;

        const dim = chalk.hex(palette.muted);
        const wrapWidth = Math.max(40, cols() - 6);

        const newLines: string[] = [];
        const paragraphs = this.thinkBuf.split('\n');
        paragraphs.forEach((para, pi) => {
            if (!para.trim()) {
                if (pi !== 0) newLines.push('');
                return;
            }
            // Apply inline markdown FIRST (bold/italic/code/links), then wrap
            // the styled string so wrapping respects ANSI escape sequences.
            // The outer dim.italic envelope adds the "thinking voice" tone;
            // bold/code segments inside still render with their own colors,
            // making **bold** stand out within the dim flow.
            const styledPara = renderInline(para);
            const wrapped = wrapVisible(styledPara, wrapWidth);
            wrapped.forEach((seg, si) => {
                const isFirstLine = (pi === 0 && si === 0);
                const prefix = isFirstLine ? `  ${dim.italic('✻ ')}` : `    `;
                newLines.push(prefix + dim.italic(seg));
            });
        });

        // Atomic swap of the block's lines in chatLog.
        this.chatLog.splice(this.thinkStartIndex, this.thinkLineCount, ...newLines);
        this.thinkLineCount = newLines.length;

        this.repaintScrollRegion();
    }

    flushThinking(): void {
        // Trailing blank line so the next block (tool call, assistant text)
        // gets visual breathing room — matches Claude Code's spacing rhythm.
        if (this.thinkLineCount > 0) {
            this.chatLog.push('');
            this.repaintScrollRegion();
        }
        this.thinkBuf = '';
        this.thinkStartIndex = null;
        this.thinkLineCount = 0;
    }

    addToolStart(name: string, args?: string): void {
        this.activeTool = { name, args, startedAt: Date.now(), frame: 0 };
        // Close the current thinking block — the tool line is a clean break.
        this.flushThinking();
        // Stop the think animation while a tool is running — only one
        // animated line in the redraw region at a time.
        this.stopThink();

        // ⏺ ToolName(arg-preview) — Claude Code's exact format.
        // Stays white throughout (running). On done, addToolDone keeps
        // the same line and adds ⎿ result lines below.
        const previewStr = args ? argPreview(args) : '';
        const display = formatToolName(name);
        const callLine = previewStr
            ? `  ${chalk.white('⏺')} ${chalk.bold(display)}${chalk.hex(palette.muted)('(' + previewStr + ')')}`
            : `  ${chalk.white('⏺')} ${chalk.bold(display)}`;
        this.activeToolLogIndex = this.chatLog.length;
        this.scrollbackLine(callLine);

        // No per-tool interval / animated spinner in the input region —
        // the global ✻ thinking… cue covers "agent is working". The
        // scrollback ⏺ line is the per-tool indicator.
        this.redraw();
    }

    addToolDone(name: string, durationMs: number, result?: string): void {
        // Capture args BEFORE stopTool() clears activeTool — otherwise the
        // done line loses the parameter preview.
        const startedArgs = this.activeTool?.args;
        this.stopTool();
        const dur = durationMs >= 1000
            ? `${(durationMs / 1000).toFixed(1)}s`
            : `${durationMs}ms`;

        const dim = chalk.hex(palette.muted);
        const display = formatToolName(name);

        // Detect error from result text (heuristic — agent.ts AgentChunk
        // has no explicit isError flag yet). Recolor ⏺ red on detected error.
        const isError = !!result && /^\s*(error|exception|traceback|✗|❌|failed?)/i.test(result);
        const dotColor = isError
            ? chalk.red('⏺')
            : chalk.hex(palette.success)('⏺');

        // The call line stays mostly intact — only the ⏺ glyph changes color.
        const previewStr = startedArgs ? argPreview(startedArgs) : '';
        const doneLine = previewStr
            ? `  ${dotColor} ${chalk.bold(display)}${dim('(' + previewStr + ')')}`
            : `  ${dotColor} ${chalk.bold(display)}`;
        if (this.activeToolLogIndex !== null && this.activeToolLogIndex < this.chatLog.length) {
            this.chatLog[this.activeToolLogIndex] = doneLine;
        } else {
            this.chatLog.push(doneLine);
        }

        // Append result lines below — Claude Code's `⎿  result_line` pattern.
        // Single line if short, multi-line if the result has line breaks.
        if (result && result.trim()) {
            const lines = formatToolResultLines(result, cols(), isError);
            for (const l of lines) this.chatLog.push(l);
        }
        // Always add a tiny duration trailer (dim, single line).
        this.chatLog.push(`     ${dim('⎿  ' + dim(`(${dur})`))}`);
        // Blank-line gap so the next block (next tool, thinking, or
        // assistant text) doesn't crash into the duration trailer —
        // Claude Code's visual rhythm.
        this.chatLog.push('');

        this.activeToolLogIndex = null;
        this.repaintScrollRegion();

        // Resume think animation if we're still streaming.
        if (this.streaming) {
            this.thinkActive = true;
            this.thinkFrame  = 0;
            this.thinkInterval = setInterval(() => {
                this.thinkFrame = (this.thinkFrame + 1) % THINK_SPIN.length;
                this.redraw();
            }, 160);
        }
        this.redraw();
    }

    addAssistantText(text: string): void {
        if (!text) return;
        this.flushThinking();
        this.turnCount++;
        // Claude Code style: no "flopsy" label, just body text with a `●`
        // dot on the first line (in brand orange) to mark a turn boundary.
        // The status bar at the bottom carries the turn counter / time.
        this.scrollbackLine('');
        // Claude Code renders the assistant message as plain markdown — no
        // persistent ✻ marker. The asterisk is only shown DURING streaming
        // (the live spinner). Once the reply settles, we just show the body.
        for (const line of renderMarkdown(text, cols())) this.scrollbackLine(line);
        this.scrollbackLine('');
        this.redraw();
    }

    addError(msg: string): void {
        this.stopTool();
        this.stopThink();
        this.scrollbackLine('');
        this.scrollbackLine(`  ${chalk.red('✗')} ${chalk.red(msg)}`);
        this.scrollbackLine('');
        this.redraw();
    }

    /**
     * Render a background-task lifecycle event in scrollback. Tasks are
     * async work spawned by tools like `spawn_background_task` or
     * sub-agent delegations — they fire and run independently of the
     * current turn, so users need a visible signal when they start /
     * progress / finish.
     */
    addTaskEvent(
        kind: 'start' | 'progress' | 'complete' | 'error',
        taskId: string,
        info?: string,
    ): void {
        const dim   = chalk.hex(palette.muted);
        const tag   = dim(`task #${taskId}`);
        const detail = info ? ' · ' + dim(info.length > 80 ? info.slice(0, 79) + '…' : info) : '';

        let line: string;
        switch (kind) {
            case 'start':
                line = `  ${chalk.cyan('◇')} ${tag} ${dim('started')}${detail}`;
                break;
            case 'progress':
                line = `  ${dim('·')} ${tag}${detail}`;
                break;
            case 'complete':
                line = `  ${chalk.hex(palette.success)('◆')} ${tag} ${dim('done')}${detail}`;
                break;
            case 'error':
                line = `  ${chalk.red('✗')} ${tag} ${chalk.red('failed')}${detail}`;
                break;
        }
        this.scrollbackLine(line);
        this.redraw();
    }

    // ── core rendering ────────────────────────────────────────────────────

    /**
     * Append a chat line. Pushes into the internal `chatLog` (so the
     * scroll region can be repainted whenever geometry changes) and
     * triggers a fresh paint of the visible window. Lines older than
     * `CHAT_LOG_MAX` are dropped from the head — bounded memory.
     */
    private scrollbackLine(content: string): void {
        this.chatLog.push(content);
        if (this.chatLog.length > ChatTUI.CHAT_LOG_MAX) this.chatLog.shift();
        if (this.scrollOffset > 0) this.unreadSince++;
        this.repaintScrollRegion();
    }

    /**
     * Paint the bottom N visible entries of `chatLog` into the current
     * scroll region using absolute positioning. Called whenever a new
     * chat line is added OR the input region's size changes (which would
     * otherwise paint over recent content).
     */
    private repaintScrollRegion(): void {
        const R = process.stdout.rows || 24;
        const top = this.bannerHeight + 1;
        const bottom = Math.max(top, R - this.lastInputH);
        const visibleRows = Math.max(0, bottom - top + 1);

        const maxOffset = Math.max(0, this.chatLog.length - visibleRows);
        if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

        const end = this.chatLog.length - this.scrollOffset;
        const start = Math.max(0, end - visibleRows);
        const visible = this.chatLog.slice(start, end);

        for (let r = top; r <= bottom; r++) {
            write(moveTo(r, 1) + clearLine);
        }
        const startRow = this.chatLog.length <= visibleRows
            ? top
            : bottom - visible.length + 1;
        for (let i = 0; i < visible.length; i++) {
            write(moveTo(startRow + i, 1) + visible[i]!);
        }
    }

    /**
     * Build the input-region lines (status + optional spinner + slash hint
     * + input lines). Returned as an array; caller paints them with
     * absolute positioning at the bottom of the screen.
     */
    private buildInputRegion(): string[] {
        const c = cols();
        const lines: string[] = [];
        // Single global "agent is working" indicator. Per-tool status
        // lives in scrollback (⏺ tool line). Even when a tool is active
        // we show ✻ thinking… here — matches Claude Code's pattern of
        // one global cue + one scrollback line per tool.
        if (this.thinkActive || this.activeTool || this.streaming) {
            lines.push(this.thinkLine());
        }
        // Claude Code pattern — the INPUT itself is sandwiched between
        // two horizontal rules:
        //   ────────── ✦ │ model │ Σ N turns │ elapsed ──     (top rule + status chip)
        //    ›  (input row — what the user types lives here)
        //   ─────────────────────────────────────────────     (bottom rule)
        //   /cmd  description                                  (slash-hint popup)
        // Slash hint sits BELOW the bottom rule so it doesn't break the
        // input's framing.
        const dim = chalk.hex(palette.muted);
        lines.push(this.statusBar(c));
        for (const il of this.renderInputLines(c)) lines.push(il);
        lines.push(dim('─'.repeat(Math.max(8, c - 2))));
        for (const h of this.slashHintLines(c)) lines.push(h);
        return lines;
    }

    /**
     * Redraw ONLY the bottom input region using absolute positioning.
     * The banner + scroll-region content are unaffected.
     *
     * If the input region size changes between draws (e.g. slash hint
     * appears), we update the DECSTBM scroll region so the bottom of the
     * scroll region always sits exactly above the input.
     */
    private redraw(): void {
        const R = process.stdout.rows || 24;
        // Hard cap on input-region height: never exceed half the terminal
        // height. Without this, a 50-line paste makes lastInputH > R, which
        // sends an invalid DECSTBM sequence (`\x1b[1;1r`) and breaks the
        // entire scroll layout. The buildInputRegion already truncates
        // input lines past this cap with a "…+N more" hint.
        const maxInputH = Math.max(3, Math.floor(R / 2));
        const allLines = this.buildInputRegion();
        const lines = allLines.length > maxInputH
            ? allLines.slice(-maxInputH)   // keep the rows nearest the input cursor
            : allLines;
        const newH = lines.length;

        if (newH !== this.lastInputH) {
            this.lastInputH = newH;
            this.setScrollRegion();
            // Repaint chat from the log so the most recent lines stay
            // visible — without this, growing the input region paints
            // over the bottom rows of chat.
            this.repaintScrollRegion();
        }

        const startRow = Math.max(this.bannerHeight + 1, R - newH + 1);
        for (let i = 0; i < newH; i++) {
            write(moveTo(startRow + i, 1) + clearLine + lines[i]);
        }
    }

    /** Repaint the entire screen: banner top, input bottom, scroll region between. */
    private repaintAll(): void {
        write(CLEAR_SCREEN);
        // Reset scroll region temporarily so we can paint the banner without
        // it scrolling, then re-set the region before painting input.
        write(RESET_SCROLL_REGION);
        if (this.bannerHeight > 0) {
            for (let i = 0; i < this.bannerLines.length; i++) {
                write(moveTo(i + 1, 1) + clearLine + this.bannerLines[i]!);
            }
        }
        // Lock the scroll region between banner bottom and input top.
        this.setScrollRegion();
        // Paint chat content from the log — preserves history across resize / redraw.
        this.repaintScrollRegion();
        this.redraw();
    }

    /** Install the DECSTBM scroll region — banner above, input below. */
    private setScrollRegion(): void {
        const R = process.stdout.rows || 24;
        const top = this.bannerHeight + 1;
        const bottom = Math.max(top, R - this.lastInputH);
        write(`${ESC}[${top};${bottom}r`);
    }

    private toolLine(): string {
        const t = this.activeTool!;
        const sym = chalk.yellow(TOOL_SPIN[t.frame % TOOL_SPIN.length]!);
        const head = chalk.bold(t.name);
        const preview = t.args ? chalk.hex(palette.muted)(` (${argPreview(t.args)})`) : '';
        return `  ${sym} ${head}${preview}`;
    }

    private thinkLine(): string {
        // Claude Code's pattern: large asterisk in brand color cycling
        // through ·/✢/✳/✶/✻/✽ — visible but not noisy. Mirrors AnimatedAsterisk.tsx.
        const sym = chalk.hex('#D77757')(THINK_SPIN[this.thinkFrame % THINK_SPIN.length]!);
        return `  ${sym} ` + chalk.hex(palette.muted).italic('thinking…');
    }

    private statusBar(c: number): string {
        const dim = (s: string) => chalk.hex(palette.muted)(s);
        const br  = chalk.hex(palette.brand);
        const sep = dim(' │ ');

        // Model in blue (palette.channel) when connected. "connecting…" in
        // warning yellow so the visual cue matches the meaning.
        const model = this.model
            ? chalk.hex(palette.channel)(this.model)
            : chalk.hex(palette.warn)('connecting…');
        const turns   = this.turnCount > 0
            ? dim(`Σ ${this.turnCount} turn${this.turnCount !== 1 ? 's' : ''}`)
            : '';
        const elapsed = dim(fmtElapsed(Date.now() - this.sessionStart));
        const scrollChip = this.scrollOffset > 0
            ? chalk.hex(palette.warn)(`↑ scrolled ${this.scrollOffset}` + (this.unreadSince > 0 ? ` · ${this.unreadSince} new` : ''))
            : '';

        const chip = [br('✦'), model, ...(turns ? [turns] : []), elapsed, ...(scrollChip ? [scrollChip] : [])].join(sep);
        const chipVis = stripAnsi(chip).length;
        const tailDashes = 2;
        const leadDashes = Math.max(2, c - chipVis - tailDashes - 2);
        return dim('─'.repeat(leadDashes)) + ' ' + chip + ' ' + dim('─'.repeat(tailDashes));
    }

    /**
     * Returns ALL prefix-matched slash commands (no upper bound). The
     * popup itself only renders a 6-row window into this list — arrow
     * keys can scroll through entries past the visible window. Empty
     * when input doesn't start with '/' or has already progressed past
     * the command name (i.e. `/cmd ` with a trailing space).
     * Shared by slashHintLines() (rendering) and onKey() (arrow navigation).
     */
    private getSlashMatches(): readonly SlashCmd[] {
        if (!this.inputBuf.startsWith('/')) return [];
        const rest = this.inputBuf.slice(1);
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx !== -1) return [];
        return SLASH_COMMANDS.filter((cmd) =>
            cmd.name.startsWith(rest.toLowerCase()),
        );
    }

    /** Build the slash-command hint popup. Returns 0..6 lines. */
    private slashHintLines(c: number): string[] {
        if (!this.inputBuf.startsWith('/')) return [];

        // Parse: word after '/' (before space), and whether args have started.
        const rest = this.inputBuf.slice(1);
        const spaceIdx = rest.indexOf(' ');
        const cmdName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
        const hasArgs = spaceIdx !== -1;

        // Inline argument hint: input is `/cmd ` and we know the arg shape.
        if (hasArgs) {
            const exact = SLASH_COMMANDS.find((cmd) => cmd.name === cmdName);
            if (exact?.argHint) {
                const dim = chalk.hex(palette.muted);
                return [`  ${dim(`↳ /${exact.name} ${exact.argHint}`)}`];
            }
            return [];
        }

        const matches = this.getSlashMatches();
        if (matches.length === 0) return [];

        // Clamp the selected index so it always points at a valid match —
        // typing further into the input filters the list and may invalidate
        // a higher index.
        if (this.slashHintIdx >= matches.length) this.slashHintIdx = 0;

        const dim    = chalk.hex(palette.muted);
        const blue   = chalk.hex(palette.channel);  // permission color — matches inline `code`
        const accent = chalk.hex('#D77757');         // brand orange for selection cursor

        // Render a fixed-size window so long lists don't blow up the input
        // region. Scroll the window so the active row stays visible — when
        // there are more matches above or below the window we surface a
        // discreet "↑ N more" / "↓ N more" indicator instead of clipping
        // silently. Matches Claude Code's command-menu pattern.
        const WINDOW = 6;
        const total = matches.length;
        const halfWindow = Math.floor(WINDOW / 2);
        let windowStart = Math.max(0, this.slashHintIdx - halfWindow);
        if (windowStart + WINDOW > total) windowStart = Math.max(0, total - WINDOW);
        const windowEnd = Math.min(total, windowStart + WINDOW);
        const visible = matches.slice(windowStart, windowEnd);

        // Compute aligned column width across the visible window only.
        const nameW = Math.max(...visible.map((m) => m.name.length));
        const lines: string[] = [];

        if (windowStart > 0) {
            lines.push(dim(`   ↑ ${windowStart} more`));
        }

        visible.forEach((m, i) => {
            const absoluteIdx = windowStart + i;
            const isActive = absoluteIdx === this.slashHintIdx && total > 1;
            const cursor   = isActive ? accent('▸') : ' ';
            const namePart = isActive
                ? blue.bold('/' + m.name.padEnd(nameW))
                : blue('/' + m.name.padEnd(nameW));
            const desc = isActive
                ? chalk.white(' ' + m.description)
                : dim(' ' + m.description);
            const raw = ` ${cursor} ${namePart} ${desc}`;
            lines.push(truncateAnsi(raw, c - 1));
        });

        if (windowEnd < total) {
            lines.push(dim(`   ↓ ${total - windowEnd} more`));
        }

        // Footer hint — only when there's something to navigate.
        if (total > 1) {
            lines.push(dim('   ↑↓ navigate · tab/enter accept · esc dismiss'));
        }
        return lines;
    }

    /**
     * Render the input area. Multi-line aware:
     *   - inputBuf may contain '\n' which forces a hard wrap
     *   - first row gets a `›` prefix; continuation rows get '  '
     *   - the cursor character (▍) is inserted at inputPos
     *
     * Returns one rendered string per visual row.
     *
     * Stays usable while streaming — typing the next message queues it
     * (Claude Code-style); pressing Enter while streaming submits as soon
     * as the current turn finishes. The status bar carries the
     * "Ctrl+C to interrupt" hint instead of replacing the input.
     */
    private renderInputLines(c: number): string[] {
        const cyan  = chalk.cyan;
        const prefix = ' › ';
        const continuationIndent = '   ';
        const innerW = Math.max(20, c - prefix.length - 1);

        // Insert the cursor block char into the buffer at inputPos.
        const withCursor = this.inputBuf.slice(0, this.inputPos) +
            CURSOR_BLOCK +
            this.inputBuf.slice(this.inputPos);

        // Split on '\n' — each becomes a logical row that may further wrap.
        const logical = withCursor.split('\n');
        const out: string[] = [];

        for (let li = 0; li < logical.length; li++) {
            const isFirst = li === 0;
            const wrapped = wrapVisible(logical[li]!, innerW);
            for (let wi = 0; wi < wrapped.length; wi++) {
                const segment = wrapped[wi]!;
                const head    = (isFirst && wi === 0) ? cyan(prefix) : continuationIndent;
                // Render the cursor block in dim cyan so it's visible but quiet.
                const styled = segment.replace(
                    CURSOR_BLOCK,
                    chalk.cyan.inverse(' '),
                );
                out.push(head + styled);
            }
        }

        return out;
    }

    // ── timers ────────────────────────────────────────────────────────────

    private stopThink(): void {
        if (this.thinkInterval !== null) {
            clearInterval(this.thinkInterval);
            this.thinkInterval = null;
        }
        this.thinkActive = false;
    }

    private stopTool(): void {
        if (this.toolInterval !== null) {
            clearInterval(this.toolInterval);
            this.toolInterval = null;
        }
        this.activeTool = null;
    }

    // ── input handling ────────────────────────────────────────────────────

    private onKey(buf: Buffer): void {
        const data = buf.toString('utf-8');

        // ESCAPE HATCH — Ctrl+C ALWAYS works, even mid-paste. Without this
        // the user gets stuck if a bracketed-paste END marker never arrives
        // (terminal protocol error, paste cancelled by OS, etc.).
        if (data === '\x03') {
            if (this.pasteBuf !== null) {
                this.cancelPaste();
                return;
            }
            if (this.streaming) { this.cbs.onInterrupt(); return; }
            this.cbs.onQuit();
            return;
        }

        // Bracketed paste accumulation
        if (data.includes(`${ESC}[200~`)) {
            this.pasteBuf = '';
            this.armPasteTimeout();
            const startIdx = data.indexOf(`${ESC}[200~`);
            const after    = data.slice(startIdx + 6);
            const endIdx   = after.indexOf(`${ESC}[201~`);
            if (endIdx !== -1) {
                this.commitAndClearPaste(after.slice(0, endIdx));
                const tail = after.slice(endIdx + 6);
                if (tail) this.onKey(Buffer.from(tail));
            } else {
                this.pasteBuf += after;
            }
            return;
        }
        if (this.pasteBuf !== null) {
            const endIdx = data.indexOf(`${ESC}[201~`);
            if (endIdx !== -1) {
                this.pasteBuf += data.slice(0, endIdx);
                this.commitAndClearPaste(this.pasteBuf);
                const tail = data.slice(endIdx + 6);
                if (tail) this.onKey(Buffer.from(tail));
            } else {
                this.pasteBuf += data;
                this.armPasteTimeout();   // Reset the watchdog with each chunk.
            }
            return;
        }

        // ── control keys (Ctrl+C handled above as escape hatch) ──
        if (data === '\x04') { this.cbs.onQuit(); return; }
        if (data === '\x15') {
            // Ctrl+U: clear current logical line
            const before = this.inputBuf.slice(0, this.inputPos);
            const after  = this.inputBuf.slice(this.inputPos);
            const lineStart = before.lastIndexOf('\n') + 1;
            this.inputBuf = before.slice(0, lineStart) + after;
            this.inputPos = lineStart;
            this.redraw();
            return;
        }
        if (data === '\x01') { // Ctrl+A — start of line
            const before = this.inputBuf.slice(0, this.inputPos);
            const lineStart = before.lastIndexOf('\n') + 1;
            this.inputPos = lineStart;
            this.redraw();
            return;
        }
        if (data === '\x05') { // Ctrl+E — end of line
            const fromCursor = this.inputBuf.slice(this.inputPos);
            const newlineRel = fromCursor.indexOf('\n');
            this.inputPos += newlineRel === -1 ? fromCursor.length : newlineRel;
            this.redraw();
            return;
        }

        // Stay typeable while streaming — Claude Code-style "queue next
        // message". The input remains editable; pressing Enter while the
        // current turn is still in flight just submits the next message.

        // Multi-byte chunk with embedded newline — most likely a paste from
        // a terminal that doesn't support bracketed paste mode. Treat the
        // whole chunk as one paste so embedded \r doesn't trigger submit.
        if (data.length > 1 && /[\r\n]/.test(data) && data.charCodeAt(0) >= 0x20) {
            this.commitPaste(data);
            return;
        }

        // Ctrl+J or Alt+Enter → insert newline.
        if (data === '\x0a' || data === `${ESC}\r` || data === `${ESC}\n`) {
            this.insertText('\n');
            return;
        }

        // Tab — accept the highlighted slash-hint suggestion (autocomplete).
        // Falls through to no-op when the popup isn't open.
        if (data === '\t') {
            const matches = this.getSlashMatches();
            if (matches.length > 0) {
                const chosen = matches[this.slashHintIdx] ?? matches[0]!;
                this.inputBuf = '/' + chosen.name + (chosen.argHint ? ' ' : '');
                this.inputPos = this.inputBuf.length;
                this.slashHintIdx = 0;
                this.redraw();
            }
            return;
        }

        // Plain Enter
        if (data === '\r' || data === '\n') {
            // Backslash-continuation: trailing '\' before Enter → newline + drop the slash.
            if (this.inputBuf.endsWith('\\') && this.inputPos === this.inputBuf.length) {
                this.inputBuf = this.inputBuf.slice(0, -1);
                this.inputPos = this.inputBuf.length;
                this.insertText('\n');
                return;
            }
            // Slash-hint accept-on-Enter: when the popup is open AND the user
            // navigated with the arrow keys (slashHintIdx > 0), Enter accepts
            // the highlighted suggestion instead of submitting the partial
            // input as-is. With no navigation, Enter still submits — preserves
            // the "type /help and hit Enter" muscle memory.
            const matches = this.getSlashMatches();
            if (matches.length > 1 && this.slashHintIdx > 0) {
                const chosen = matches[this.slashHintIdx]!;
                this.inputBuf = '/' + chosen.name + (chosen.argHint ? ' ' : '');
                this.inputPos = this.inputBuf.length;
                this.slashHintIdx = 0;
                this.redraw();
                return;
            }
            this.submit();
            return;
        }

        if (data === '\x7f' || data === '\b') { this.backspace(); return; }

        if (data.startsWith(`${ESC}[`) || data.startsWith(`${ESC}O`)) {
            this.handleEscape(data.slice(2));
            return;
        }

        // Normal printable characters (including tabs as spaces, multi-byte UTF-8)
        if (data.length >= 1 && data.charCodeAt(0) >= 0x20) {
            this.insertText(data);
        }
    }

    private handleEscape(seq: string): void {
        switch (seq) {
            case 'A': {
                // Slash-hint navigation when the popup is open with multiple
                // matches; otherwise fall through to history.
                const matches = this.getSlashMatches();
                if (matches.length > 1) {
                    this.slashHintIdx =
                        (this.slashHintIdx - 1 + matches.length) % matches.length;
                    this.redraw();
                } else {
                    this.historyUp();
                }
                break;
            }
            case 'B': {
                const matches = this.getSlashMatches();
                if (matches.length > 1) {
                    this.slashHintIdx = (this.slashHintIdx + 1) % matches.length;
                    this.redraw();
                } else {
                    this.historyDown();
                }
                break;
            }
            case 'C': if (this.inputPos < this.inputBuf.length) { this.inputPos++; this.redraw(); } break;
            case 'D': if (this.inputPos > 0) { this.inputPos--; this.redraw(); } break;
            case 'H': case '1~': {
                // Home — start of input.
                this.inputPos = 0; this.redraw(); break;
            }
            case 'F': case '4~': {
                // End — end of input.
                this.inputPos = this.inputBuf.length; this.redraw(); break;
            }
            case '3~':
                if (this.inputPos < this.inputBuf.length) {
                    this.inputBuf = this.inputBuf.slice(0, this.inputPos) +
                                    this.inputBuf.slice(this.inputPos + 1);
                    this.redraw();
                }
                break;
            case '5~': this.scrollUp(this.pageSize()); break;        // PageUp
            case '6~': this.scrollDown(this.pageSize()); break;       // PageDown
            case '1;2A': case '1;5A': this.scrollUp(1); break;        // Shift+Up / Ctrl+Up
            case '1;2B': case '1;5B': this.scrollDown(1); break;      // Shift+Down / Ctrl+Down
        }
    }

    private pageSize(): number {
        const R = process.stdout.rows || 24;
        const visibleRows = Math.max(1, R - this.lastInputH - this.bannerHeight);
        return Math.max(1, visibleRows - 2);
    }

    private scrollUp(n: number): void {
        const R = process.stdout.rows || 24;
        const visibleRows = Math.max(1, R - this.lastInputH - this.bannerHeight);
        const maxOffset = Math.max(0, this.chatLog.length - visibleRows);
        const before = this.scrollOffset;
        this.scrollOffset = Math.min(maxOffset, this.scrollOffset + n);
        if (this.scrollOffset !== before) {
            if (before === 0) this.unreadSince = 0;
            this.repaintScrollRegion();
            this.redraw();
        }
    }

    private scrollDown(n: number): void {
        const before = this.scrollOffset;
        this.scrollOffset = Math.max(0, this.scrollOffset - n);
        if (this.scrollOffset === 0) this.unreadSince = 0;
        if (this.scrollOffset !== before) {
            this.repaintScrollRegion();
            this.redraw();
        }
    }

    private insertText(text: string): void {
        this.inputBuf =
            this.inputBuf.slice(0, this.inputPos) + text + this.inputBuf.slice(this.inputPos);
        this.inputPos += text.length;
        // Typing changes which commands match — reset selection to the top.
        this.slashHintIdx = 0;
        this.redraw();
    }

    private commitPaste(text: string): void {
        // Normalise \r\n / \r to \n.
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        this.insertText(normalized);
    }

    /** Commit whatever's in pasteBuf and clear paste state cleanly. */
    private commitAndClearPaste(text: string): void {
        this.commitPaste(text);
        this.pasteBuf = null;
        this.clearPasteTimeout();
    }

    /** Discard the partial paste — used by Ctrl+C escape hatch. */
    private cancelPaste(): void {
        this.pasteBuf = null;
        this.clearPasteTimeout();
        this.redraw();
    }

    /**
     * Re-arm the paste watchdog. If no chunk arrives for PASTE_TIMEOUT_MS
     * after the last one, commit whatever we have and exit paste mode —
     * prevents the user from getting stuck when the terminal never sends
     * the closing `\x1b[201~`.
     */
    private armPasteTimeout(): void {
        this.clearPasteTimeout();
        this.pasteTimer = setTimeout(() => {
            this.pasteTimer = null;
            if (this.pasteBuf !== null) {
                const text = this.pasteBuf;
                this.pasteBuf = null;
                this.commitPaste(text);
            }
        }, ChatTUI.PASTE_TIMEOUT_MS);
        this.pasteTimer.unref();
    }

    private clearPasteTimeout(): void {
        if (this.pasteTimer !== null) {
            clearTimeout(this.pasteTimer);
            this.pasteTimer = null;
        }
    }

    private submit(): void {
        const text = this.inputBuf.trim();
        if (!text) return;

        // Local exit commands — consumed in the TUI, never sent to the agent.
        if (text === '/exit' || text === '/quit' || text === '/q') {
            this.inputBuf = '';
            this.inputPos = 0;
            this.cbs.onQuit();
            return;
        }

        if (text !== this.history[0]) this.history.unshift(text);
        if (this.history.length > 200) this.history.pop();
        this.histIdx = -1;
        this.histTmp = '';
        this.inputBuf = '';
        this.inputPos = 0;
        this.redraw();
        this.cbs.onSend(text);
    }

    private backspace(): void {
        if (this.inputPos > 0) {
            this.inputBuf = this.inputBuf.slice(0, this.inputPos - 1) +
                            this.inputBuf.slice(this.inputPos);
            this.inputPos--;
            this.slashHintIdx = 0;
            this.redraw();
        }
    }

    private historyUp(): void {
        if (!this.history.length) return;
        if (this.histIdx === -1) this.histTmp = this.inputBuf;
        if (this.histIdx < this.history.length - 1) {
            this.histIdx++;
            this.inputBuf = this.history[this.histIdx]!;
            this.inputPos = this.inputBuf.length;
            this.redraw();
        }
    }

    private historyDown(): void {
        if (this.histIdx < 0) return;
        this.histIdx--;
        this.inputBuf = this.histIdx >= 0 ? this.history[this.histIdx]! : this.histTmp;
        this.inputPos = this.inputBuf.length;
        this.redraw();
    }
}

// ── helpers ───────────────────────────────────────────────────────────────

function fmtTime(): string {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function center(s: string, width: number): string {
    const vis = stripAnsi(s).length;
    if (vis >= width) return s;
    const pad = Math.floor((width - vis) / 2);
    return ' '.repeat(pad) + s;
}

function padRight(s: string, width: number): string {
    const vis = stripAnsi(s).length;
    return vis < width ? s + ' '.repeat(width - vis) : s;
}

/** Width-aware single-line wrap. Splits at last space ≤ width when possible. */
function wrapVisible(text: string, width: number): string[] {
    if (width <= 0) return [text];
    const visualLen = stripAnsi(text).length;
    if (visualLen <= width) return [text];

    // Single-pass O(N) walk over the input. Previous implementation called
    // `stripAnsi(rest)` and `rest.slice(...).trimStart()` per iteration —
    // O(N²) in the input size. With a 100KB paste that meant seconds-long
    // freezes per keystroke. This pass advances ONE pointer through the
    // string and emits cut indices.
    const out: string[] = [];
    let segStart = 0;          // raw start of the current visible segment
    let visCount = 0;          // visible chars in the current segment
    let lastSpace = -1;        // raw index of the last space in segment
    let i = 0;
    const n = text.length;

    while (i < n) {
        // Skip ANSI CSI escapes — they're invisible.
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
            // Cut at the last space if we have one; otherwise hard-cut here.
            const cut = lastSpace > segStart ? lastSpace : i;
            out.push(text.slice(segStart, cut).trimEnd());
            // Skip leading spaces of the next segment.
            let next = cut;
            while (next < n && text[next] === ' ') next++;
            segStart = next;
            i = next;
            visCount = 0;
            lastSpace = -1;

            // Safety: if we made no forward progress, force one char and continue.
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
function truncateAnsi(text: string, width: number): string {
    if (stripAnsi(text).length <= width) return text;
    let visCount = 0;
    let rawIdx   = 0;
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

/**
 * Snake_case / kebab-case → Title Case for the displayed tool name.
 * `web_search` → `WebSearch`, `delegate_task` → `DelegateTask`,
 * `Bash` (already PascalCase) → `Bash`. Matches Claude Code's display
 * convention of `ToolName(args)`.
 */
function formatToolName(raw: string): string {
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
 * Order: file paths → URLs → query/text/prompt → first string field.
 * Falls back to a comma-separated list of keys when no string value exists.
 */
function argPreview(args: string): string {
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
        // Self-describing keys: omit the key name.
        if (k === 'file_path' || k === 'path' || k === 'url' || k === 'href') return val;
        return `${k}: ${val}`;
    }
    return entries.slice(0, 3).map(([k]) => k).join(', ');
}

/**
 * Format tool result for display below the call line — Claude Code's
 * `⎿  result` pattern. Multi-line results render up to N lines with the
 * `⎿  ` curve glyph on the first line and indent on continuations;
 * results longer than the cap end with a truncation hint.
 */
function formatToolResultLines(result: string, termWidth: number, isError: boolean): string[] {
    const dim = chalk.hex(palette.muted);
    const errClr = chalk.red;
    const trimmed = result.trim();
    if (!trimmed) return [];

    const innerW = Math.max(40, termWidth - 8);
    const MAX_LINES = 6;
    const rawLines = trimmed.split('\n');

    // Wrap each raw line.
    const out: string[] = [];
    let used = 0;
    for (let li = 0; li < rawLines.length; li++) {
        if (used >= MAX_LINES) {
            const remaining = rawLines.length - li;
            out.push(`     ${dim('⎿  ')}${dim(`… (${remaining} more line${remaining !== 1 ? 's' : ''})`)}`);
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

type TableAlign = 'left' | 'center' | 'right';

/**
 * Parse a markdown table starting at `lines[startIdx]`. Caller has already
 * verified the header line is `|...|` and the next line looks like a
 * separator. Returns parsed cells per row, alignment per column, and the
 * index of the first non-table line so the caller can resume processing.
 */
function parseMarkdownTable(
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
        // Pad short rows so all rows have the same column count.
        while (cells.length < headerCells.length) cells.push('');
        rows.push(cells);
        i++;
    }

    // Pad alignment array to header width if separator had fewer cols.
    while (aligns.length < headerCells.length) aligns.push('left');

    return { rows, aligns, endIdx: i };
}

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

/**
 * Render a parsed markdown table with box-drawing borders, matching
 * Claude Code's `MarkdownTable.tsx`. Per-column widths derived from
 * cell content widths; if total width exceeds the available terminal
 * space, scale all columns proportionally with a 3-char minimum.
 * Cells are rendered with inline markdown applied (bold/code/links).
 */
function renderTable(rows: string[][], aligns: TableAlign[], availW: number): string[] {
    const dim = chalk.hex(palette.muted);
    const numCols = Math.max(...rows.map((r) => r.length));
    if (numCols === 0) return [];

    // Pre-render every cell to get its visible width (after inline markdown).
    const renderedCells: string[][] = rows.map((row) =>
        row.map((c, ci) => {
            const styled = renderInline(c);
            return ci === 0 || row === rows[0] ? styled : styled;
        }),
    );

    // Compute ideal width per column = max visible width across all rows.
    const idealWidths: number[] = [];
    for (let c = 0; c < numCols; c++) {
        let max = 3;
        for (let r = 0; r < renderedCells.length; r++) {
            const cell = renderedCells[r]![c] ?? '';
            const len = stripAnsi(cell).length;
            if (len > max) max = len;
        }
        idealWidths.push(max);
    }

    // Fit-to-terminal: each col uses (width + 2) for padding + 1 for `│`,
    // plus one leading `│`. Total chrome = 1 + numCols * 3.
    const chrome = 1 + numCols * 3;
    const idealSum = idealWidths.reduce((a, b) => a + b, 0);
    let columnWidths = idealWidths;
    if (chrome + idealSum > availW) {
        const slack = Math.max(numCols * 3, availW - chrome);
        const scale = slack / idealSum;
        columnWidths = idealWidths.map((w) => Math.max(3, Math.floor(w * scale)));
    }

    const out: string[] = [];

    const buildBorder = (l: string, mid: string, r: string): string => {
        let s = l;
        columnWidths.forEach((w, i) => {
            s += '─'.repeat(w + 2);
            s += i < columnWidths.length - 1 ? mid : r;
        });
        return dim(s);
    };

    out.push(buildBorder('┌', '┬', '┐'));

    // Header row — bold cells.
    out.push(renderTableRow(rows[0]!, columnWidths, aligns, true));

    out.push(buildBorder('├', '┼', '┤'));

    for (let r = 1; r < rows.length; r++) {
        out.push(renderTableRow(rows[r]!, columnWidths, aligns, false));
    }

    out.push(buildBorder('└', '┴', '┘'));
    return out;
}

function renderTableRow(
    cells: string[],
    widths: number[],
    aligns: TableAlign[],
    isHeader: boolean,
): string {
    const dim = chalk.hex(palette.muted);
    let line = dim('│');
    for (let i = 0; i < widths.length; i++) {
        const raw = cells[i] ?? '';
        let styled = renderInline(raw);
        if (isHeader) styled = chalk.bold(styled);
        const truncated = truncateAnsi(styled, widths[i]!);
        const visLen = stripAnsi(truncated).length;
        const padded = padCellAlign(truncated, visLen, widths[i]!, aligns[i] ?? 'left');
        line += ' ' + padded + ' ' + dim('│');
    }
    return line;
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

/**
 * Markdown renderer for assistant replies.
 *
 * Mirrors Claude Code's `src/utils/markdown.ts` token semantics with a
 * lightweight regex pass (no `marked` dep): fenced code blocks with a
 * ▎ side-rail (BLOCKQUOTE_BAR), blockquotes with ▎ + italic, headings
 * (h1 bold underlined, h2/h3 bold), bullet/numbered lists with markers,
 * inline `code` in amber, **bold**, *italic*, `[text](url)` and bare URLs
 * in blue + underlined.
 */
function renderMarkdown(text: string, termWidth: number): string[] {
    const out: string[] = [];
    const indent = '  ';
    const innerW = Math.max(40, termWidth - indent.length - 2);
    const dim = chalk.hex(palette.muted);
    const accent = chalk.hex('#D77757');
    const blue = chalk.hex(palette.channel);   // permission color in Claude's vocab

    let inCode = false;
    let codeLang = '';
    let codeBuf: string[] = [];
    const lines = text.split('\n');

    const flushCodeBlock = (): void => {
        if (codeBuf.length === 0) {
            out.push(indent + dim('─── ' + (codeLang || 'code') + ' ───'));
            out.push(indent + dim('───'));
            return;
        }
        const digits = String(codeBuf.length).length;
        const header = '─── ' + (codeLang || 'code') + ' ' + '─'.repeat(Math.max(3, innerW - digits - 8 - codeLang.length));
        out.push(indent + dim(header));
        for (let i = 0; i < codeBuf.length; i++) {
            const num = String(i + 1).padStart(digits, ' ');
            out.push(indent + dim(num + ' ') + chalk.cyan(codeBuf[i]!));
        }
        out.push(indent + dim('─'.repeat(Math.min(60, innerW))));
        codeBuf = [];
        codeLang = '';
    };

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const raw = lines[lineIdx]!;

        if (!inCode && /^\s*\|.*\|\s*$/.test(raw)) {
            const sep = lines[lineIdx + 1];
            if (sep && /^\s*\|[\s:|\-]+\|\s*$/.test(sep)) {
                const tbl = parseMarkdownTable(lines, lineIdx);
                if (tbl) {
                    for (const tl of renderTable(tbl.rows, tbl.aligns, innerW)) out.push(indent + tl);
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

        // Headings — Claude-style hierarchy:
        //   h1  → brand orange + bold + underline (top-level section)
        //   h2  → bold white
        //   h3+ → bold dim
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

        // Blockquote — blue ▎ bar + italic body. Matches Claude's
        // `permission`-coloured emphasis on quoted/referenced content.
        const blockquote = raw.match(/^>\s?(.*)$/);
        if (blockquote) {
            const styled = chalk.italic(renderInline(blockquote[1]!));
            for (const wl of wrapVisible(styled, innerW - 2)) {
                out.push(indent + blue('▎ ') + wl);
            }
            continue;
        }

        // Horizontal rule — `---` / `***` / `___` on its own line
        if (/^([-*_])\1{2,}\s*$/.test(raw)) {
            out.push(indent + dim('─'.repeat(Math.min(40, innerW))));
            continue;
        }

        // Bulleted list — `- item` / `* item` / `+ item`
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

        // Ordered list — `1. item` / `2) item`
        const ordered = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
        if (ordered) {
            const lead = ordered[1] ?? '';
            const num  = ordered[2]!;
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

// Color language (Claude Code conventions):
//   `code` → blue (palette.channel = `permission` in Claude vocab)
//   [text](url) / bare URLs → blue + underline
//   **bold** → bold + warning amber tint (subtle emphasis)
//   *italic* → italic only
// Order matters: code spans first so URLs inside `code` stay code-coloured.
function renderInline(text: string): string {
    return text
        .replace(/`([^`]+)`/g, (_, c: string) => chalk.hex(palette.channel)(c))
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) =>
            chalk.hex(palette.channel).underline(label) +
            chalk.hex(palette.muted)(' (') +
            chalk.hex(palette.channel).underline(url) +
            chalk.hex(palette.muted)(')'))
        .replace(/\b(https?:\/\/[^\s)\]]+)/g, (_, url: string) =>
            chalk.hex(palette.channel).underline(url))
        .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => chalk.hex(palette.warn).bold(t))
        .replace(/\*([^*]+)\*/g, (_, t: string) => chalk.italic(t));
}
