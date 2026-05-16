/**
 * Keyboard input handler for the chat TUI.
 *
 * Handles raw terminal input: escape sequences, control keys, bracketed
 * paste, and printable characters. Exposes a simple interface for the TUI
 * to call on each stdin chunk.
 */

import { getSlashMatches } from '../components/slash-hints';

const ESC = '\x1b';
const CURSOR_BLOCK = '▍';

export interface InputState {
    buf: string;
    pos: number;
    history: string[];
    histIdx: number;
    histTmp: string;
    slashHintIdx: number;
}

export interface InputCallbacks {
    onSubmit(): void;
    onQuit(): void;
    onRedraw(): void;
    onToggleExpand?: () => void;
    onPageUp?: () => void;
    onPageDown?: () => void;
    /**
     * Interrupt the current in-flight turn. Called on Ctrl+C while
     * `isStreaming()` returns true. The TUI uses this to abort the
     * pending agent response without exiting the CLI.
     */
    onInterrupt?: () => void;
    /**
     * Notice to the user — typically "Press Ctrl+C again to exit"
     * after the first idle Ctrl+C. Optional; if not supplied, the idle
     * Ctrl+C immediately quits (legacy behaviour).
     */
    onNotice?: (text: string) => void;
    /**
     * True when an agent turn is currently streaming. Used to decide
     * whether Ctrl+C should interrupt (streaming) or arm-then-quit
     * (idle).
     */
    isStreaming?: () => boolean;
}

function createInputState(): InputState {
    return { buf: '', pos: 0, history: [], histIdx: -1, histTmp: '', slashHintIdx: 0 };
}

export class InputHandler {
    state = createInputState();
    private pasteBuf: string | null = null;
    private pasteTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly PASTE_TIMEOUT_MS = 500;
    /** Paste threshold: anything >= this many chars OR with any newline becomes a [Pasted text #N] placeholder. */
    private static readonly PASTE_COLLAPSE_CHARS = 500;
    /** Real text behind each [Pasted text #N] placeholder in the buffer. Expanded on consume(). */
    private pastedContents = new Map<number, string>();
    private nextPasteId = 1;
    /**
     * Ctrl+C double-tap state: when the user presses Ctrl+C while idle,
     * we arm a 2s window. A second Ctrl+C inside that window exits;
     * outside it, the cycle restarts.
     */
    private quitArmedTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly QUIT_ARM_WINDOW_MS = 2_000;

    constructor(private readonly cbs: InputCallbacks) {}

    handle(buf: Buffer): void {
        const data = buf.toString('utf-8');

        // Ctrl+C handling — three-way:
        //   1. Mid-paste                → cancel the pending paste
        //   2. While streaming a turn   → interrupt the agent (don't quit)
        //   3. Idle, no double-tap yet  → arm "press again to exit" window
        //   4. Idle, within window      → quit
        if (data === '\x03') {
            if (this.pasteBuf !== null) { this.cancelPaste(); return; }

            // Streaming → interrupt and do not arm-quit. Sending Ctrl+C
            // stops the agent's reply; the user stays in the chat.
            if (this.cbs.isStreaming?.()) {
                this.cbs.onInterrupt?.();
                this.clearQuitArm();
                return;
            }

            // Idle: arm-then-quit. First Ctrl+C is a soft signal so the
            // user doesn't lose their conversation by accident.
            if (this.quitArmedTimer) {
                this.clearQuitArm();
                this.cbs.onQuit();
                return;
            }
            // No notice handler → legacy immediate-quit behaviour.
            if (!this.cbs.onNotice) {
                this.cbs.onQuit();
                return;
            }
            this.cbs.onNotice('Press Ctrl+C again to exit (or /quit).');
            this.quitArmedTimer = setTimeout(() => {
                this.quitArmedTimer = null;
            }, InputHandler.QUIT_ARM_WINDOW_MS);
            return;
        }
        // Any other input invalidates the quit-arm window — a Ctrl+C that
        // landed seconds ago shouldn't fire-and-forget once the user
        // resumes typing.
        this.clearQuitArm();

        // Bracketed paste
        if (data.includes(`${ESC}[200~`)) {
            this.pasteBuf = '';
            this.armPasteTimeout();
            const startIdx = data.indexOf(`${ESC}[200~`);
            const after = data.slice(startIdx + 6);
            const endIdx = after.indexOf(`${ESC}[201~`);
            if (endIdx !== -1) {
                this.commitAndClearPaste(after.slice(0, endIdx));
                const tail = after.slice(endIdx + 6);
                if (tail) this.handle(Buffer.from(tail));
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
                if (tail) this.handle(Buffer.from(tail));
            } else {
                this.pasteBuf += data;
                this.armPasteTimeout();
            }
            return;
        }

        // Ctrl+O — expansion toggle
        if (data === '\x0f') { this.cbs.onToggleExpand?.(); return; }

        // Ctrl+D — quit
        if (data === '\x04') { this.cbs.onQuit(); return; }

        // Ctrl+U — clear current logical line
        if (data === '\x15') {
            const before = this.state.buf.slice(0, this.state.pos);
            const after = this.state.buf.slice(this.state.pos);
            const lineStart = before.lastIndexOf('\n') + 1;
            this.state.buf = before.slice(0, lineStart) + after;
            this.state.pos = lineStart;
            this.cbs.onRedraw();
            return;
        }

        // Ctrl+A — start of line
        if (data === '\x01') {
            const before = this.state.buf.slice(0, this.state.pos);
            this.state.pos = before.lastIndexOf('\n') + 1;
            this.cbs.onRedraw();
            return;
        }

        // Ctrl+E — end of line
        if (data === '\x05') {
            const rest = this.state.buf.slice(this.state.pos);
            const newlineRel = rest.indexOf('\n');
            this.state.pos += newlineRel === -1 ? rest.length : newlineRel;
            this.cbs.onRedraw();
            return;
        }

        // Multi-byte paste (no bracketed paste support)
        if (data.length > 1 && /[\r\n]/.test(data) && data.charCodeAt(0) >= 0x20) {
            this.commitPaste(data);
            return;
        }

        // Ctrl+J or Alt+Enter → insert newline
        if (data === '\x0a' || data === `${ESC}\r` || data === `${ESC}\n`) {
            this.insertText('\n');
            return;
        }

        // Tab — accept slash-hint suggestion
        if (data === '\t') {
            const matches = getSlashMatches(this.state.buf);
            if (matches.length > 0) {
                const chosen = matches[this.state.slashHintIdx] ?? matches[0]!;
                this.state.buf = '/' + chosen.name + (chosen.argHint ? ' ' : '');
                this.state.pos = this.state.buf.length;
                this.state.slashHintIdx = 0;
                this.cbs.onRedraw();
            }
            return;
        }

        // Enter
        if (data === '\r' || data === '\n') {
            // backslash-continuation
            if (this.state.buf.endsWith('\\') && this.state.pos === this.state.buf.length) {
                this.state.buf = this.state.buf.slice(0, -1);
                this.state.pos = this.state.buf.length;
                this.insertText('\n');
                return;
            }
            // slash-hint accept-on-enter
            const matches = getSlashMatches(this.state.buf);
            if (matches.length > 1 && this.state.slashHintIdx > 0) {
                const chosen = matches[this.state.slashHintIdx]!;
                this.state.buf = '/' + chosen.name + (chosen.argHint ? ' ' : '');
                this.state.pos = this.state.buf.length;
                this.state.slashHintIdx = 0;
                this.cbs.onRedraw();
                return;
            }
            this.cbs.onSubmit();
            return;
        }

        // Backspace
        if (data === '\x7f' || data === '\b') {
            if (this.state.pos > 0) {
                this.state.buf = this.state.buf.slice(0, this.state.pos - 1) +
                                 this.state.buf.slice(this.state.pos);
                this.state.pos--;
                this.state.slashHintIdx = 0;
                this.cbs.onRedraw();
            }
            return;
        }

        // Escape sequences (arrows, home, end, delete, page up/down, etc.)
        if (data.startsWith(`${ESC}[`) || data.startsWith(`${ESC}O`)) {
            this.handleEscape(data.slice(2));
            return;
        }

        // Printable
        if (data.length >= 1 && data.charCodeAt(0) >= 0x20) {
            this.insertText(data);
        }
    }

    /**
     * Consume the current input and reset. Returns:
     *   `display`  — raw with `[Pasted text #N]` placeholders intact (for chat history)
     *   `expanded` — placeholders substituted with their full content (for the agent)
     *   `pastes`   — id → full text map so the TUI can later expand placeholders on Ctrl+O
     */
    consume(): { display: string; expanded: string; pastes: Map<number, string> } {
        const raw = this.state.buf.trim();
        const expanded = this.expandPasteRefs(raw);
        const pastes = new Map(this.pastedContents);
        if (raw && raw !== this.state.history[0]) {
            this.state.history.unshift(raw);
            if (this.state.history.length > 200) this.state.history.pop();
        }
        this.state.buf = '';
        this.state.pos = 0;
        this.state.histIdx = -1;
        this.state.histTmp = '';
        this.state.slashHintIdx = 0;
        this.pastedContents.clear();
        this.nextPasteId = 1;
        return { display: raw, expanded, pastes };
    }

    private expandPasteRefs(input: string): string {
        if (this.pastedContents.size === 0) return input;
        // Permissive regex — matches any extras after #N (line/char count,
        // ctrl+O hint, future changes) up to the closing bracket.
        return input.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (match, idStr) => {
            const id = parseInt(idStr, 10);
            const content = this.pastedContents.get(id);
            return content ?? match;
        });
    }

    /** Insert text at cursor position. */
    insertText(text: string): void {
        this.state.buf = this.state.buf.slice(0, this.state.pos) +
                         text + this.state.buf.slice(this.state.pos);
        this.state.pos += text.length;
        this.state.slashHintIdx = 0;
        this.cbs.onRedraw();
    }

    /** Build the rendered input lines (multi-line aware). */
    renderInputLines(termWidth: number): string[] {
        const cyan = '\x1b[36m'; // chalk.cyan
        const dim = '\x1b[2m';
        const reset = '\x1b[0m';
        const prefix = ' › ';
        const continuationIndent = '   ';
        const innerW = Math.max(20, termWidth - prefix.length - 1);

        // Insert the cursor block in the raw buffer first, then regex-style
        // [Pasted text #N ...] placeholders so they read as collapsed-paste
        // tags. When the cursor lands INSIDE a placeholder its regex match
        // breaks and the placeholder temporarily renders unstyled — acceptable
        // edge case for an otherwise simple pipeline.
        const rawWithCursor = this.state.buf.slice(0, this.state.pos) +
            CURSOR_BLOCK + this.state.buf.slice(this.state.pos);
        const withCursor = rawWithCursor.replace(
            /\[Pasted text #\d+[^\]]*\]/g,
            (m) => `${dim}${cyan}${m}${reset}`,
        );

        const logical = withCursor.split('\n');
        const out: string[] = [];

        // Simple ANSI-aware wrap (inline — avoids circular dep on text-utils)
        const wrap = (t: string, w: number): string[] => {
            const visLen = t.replace(/\x1b\[[0-9;]*m/g, '').length;
            if (visLen <= w) return [t];
            const result: string[] = [];
            let seg = 0, cnt = 0, ls = -1, j = 0;
            const L = t.length;
            while (j < L) {
                if (t[j] === '\x1b' && t[j + 1] === '[') {
                    let e = j + 2;
                    while (e < L && t[e] !== 'm') e++;
                    j = e + 1; continue;
                }
                if (t[j] === ' ') ls = j;
                cnt++; j++;
                if (cnt >= w) {
                    const cut = ls > seg ? ls : j;
                    result.push(t.slice(seg, cut).trimEnd());
                    let n = cut;
                    while (n < L && t[n] === ' ') n++;
                    seg = n; j = n; cnt = 0; ls = -1;
                    if (seg === cut && cut === j) j = seg + 1;
                }
            }
            if (seg < L) { const tl = t.slice(seg); if (tl) result.push(tl); }
            return result;
        };

        for (let li = 0; li < logical.length; li++) {
            const isFirst = li === 0;
            const wrapped = wrap(logical[li]!, innerW);
            for (let wi = 0; wi < wrapped.length; wi++) {
                const head = (isFirst && wi === 0) ? cyan + prefix + reset : continuationIndent;
                const seg = wrapped[wi]!.replace(CURSOR_BLOCK, cyan + '\x1b[7m \x1b[27m' + reset);
                out.push(head + seg);
            }
        }
        return out;
    }

    // ── private ────────────────────────────────────────────────────────────

    private handleEscape(seq: string): void {
        const matches = getSlashMatches(this.state.buf);
        switch (seq) {
            case 'A': // up
                if (matches.length > 1) {
                    this.state.slashHintIdx =
                        (this.state.slashHintIdx - 1 + matches.length) % matches.length;
                } else {
                    if (this.state.history.length && this.state.histIdx === -1)
                        this.state.histTmp = this.state.buf;
                    if (this.state.histIdx < this.state.history.length - 1) {
                        this.state.histIdx++;
                        this.state.buf = this.state.history[this.state.histIdx]!;
                        this.state.pos = this.state.buf.length;
                    }
                }
                this.cbs.onRedraw();
                break;
            case 'B': // down
                if (matches.length > 1) {
                    this.state.slashHintIdx = (this.state.slashHintIdx + 1) % matches.length;
                } else {
                    if (this.state.histIdx >= 0) {
                        this.state.histIdx--;
                        this.state.buf = this.state.histIdx >= 0
                            ? this.state.history[this.state.histIdx]!
                            : this.state.histTmp;
                        this.state.pos = this.state.buf.length;
                    }
                }
                this.cbs.onRedraw();
                break;
            case '5~': this.cbs.onPageUp?.(); break;  // Page Up
            case '6~': this.cbs.onPageDown?.(); break; // Page Down
            case 'C': if (this.state.pos < this.state.buf.length) { this.state.pos++; this.cbs.onRedraw(); } break;
            case 'D': if (this.state.pos > 0) { this.state.pos--; this.cbs.onRedraw(); } break;
            case 'H': case '1~': this.state.pos = 0; this.cbs.onRedraw(); break;
            case 'F': case '4~': this.state.pos = this.state.buf.length; this.cbs.onRedraw(); break;
            case '3~': // delete
                if (this.state.pos < this.state.buf.length) {
                    this.state.buf = this.state.buf.slice(0, this.state.pos) +
                                     this.state.buf.slice(this.state.pos + 1);
                    this.cbs.onRedraw();
                }
                break;
        }
    }

    private commitPaste(text: string): void {
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const newlineCount = (normalized.match(/\n/g) || []).length;
        // Collapse the paste into a placeholder when it's multi-line or
        // very long — same UX as claude-code's "[Pasted text #N +K lines]"
        // with a Ctrl+O hint appended so users discover the expand toggle.
        // Short single-line pastes (snippets, urls) flow inline as before.
        if (newlineCount > 0 || normalized.length >= InputHandler.PASTE_COLLAPSE_CHARS) {
            const id = this.nextPasteId++;
            this.pastedContents.set(id, normalized);
            const size = newlineCount > 0
                ? `+${newlineCount} lines`
                : `${normalized.length} chars`;
            const placeholder = `[Pasted text #${id} ${size} · ctrl+O to expand]`;
            this.insertText(placeholder);
            return;
        }
        this.insertText(normalized);
    }

    private commitAndClearPaste(text: string): void {
        this.commitPaste(text);
        this.pasteBuf = null;
        this.clearPasteTimeout();
    }

    private cancelPaste(): void {
        this.pasteBuf = null;
        this.clearPasteTimeout();
        this.cbs.onRedraw();
    }

    private clearQuitArm(): void {
        if (this.quitArmedTimer !== null) {
            clearTimeout(this.quitArmedTimer);
            this.quitArmedTimer = null;
        }
    }

    private armPasteTimeout(): void {
        this.clearPasteTimeout();
        this.pasteTimer = setTimeout(() => {
            this.pasteTimer = null;
            if (this.pasteBuf !== null) {
                const text = this.pasteBuf;
                this.pasteBuf = null;
                this.commitPaste(text);
            }
        }, InputHandler.PASTE_TIMEOUT_MS);
        this.pasteTimer.unref();
    }

    private clearPasteTimeout(): void {
        if (this.pasteTimer !== null) {
            clearTimeout(this.pasteTimer);
            this.pasteTimer = null;
        }
    }
}