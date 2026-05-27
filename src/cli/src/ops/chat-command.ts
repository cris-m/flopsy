import { type Command } from 'commander';
import { userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { loadMgmtToken } from '@flopsy/shared';
import { managementUrl } from './schedule-client';
import { ChatTUI } from '../ui/chat-tui';

// Wire-protocol types (mirror gateway/src/management/chat-handler.ts — no cross-package import needed)
type AgentChunk =
    | { type: 'text_delta';  text: string }
    | { type: 'thinking';    text: string }
    | { type: 'tool_start';  toolName: string; args?: string }
    | { type: 'tool_result'; toolName: string; result?: string };

interface DoneUsage {
    input: number;
    output: number;
    reasoning?: number;
    cached?: number;
    contextTokens?: number;
    contextLimit?: number;
}

type ServerEvent =
    | { type: 'ready';  threadId: string; model?: string }
    | { type: 'chunk';  chunk: AgentChunk }
    | { type: 'task';   event: 'start' | 'progress' | 'complete' | 'error'; taskId: string; description?: string; result?: string; error?: string }
    | { type: 'done';   text: string | null; usage?: DoneUsage }
    | { type: 'compaction'; threadId: string; tokensBefore: number; tokensAfter: number; threshold: number; strategy: 'clear-tools' | 'summarize' | 'both'; durationMs: number }
    | { type: 'error';  message: string };

/** Resolve the current git branch once (chat cwd is fixed for the session). Empty string when not a repo. */
function detectGitBranch(cwd: string): Promise<string> {
    return new Promise((resolve) => {
        execFile('git', ['branch', '--show-current'], { cwd, timeout: 1000 }, (err, stdout) => {
            if (err) { resolve(''); return; }
            const branch = stdout.trim();
            resolve(branch ? `(${branch})` : '');
        });
    });
}

type ClientMessage =
    | { type: 'message';   text: string }
    | { type: 'interrupt' }
    | { type: 'status' }
    | { type: 'tasks' }
    | { type: 'compact' }
    | { type: 'new' };

// Reconnect backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s. Cap is high enough
// to back off a flapping gateway without spinning, low enough that a user
// returning from sleep waits at most 30s for the next attempt.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const MAX_PENDING_MESSAGES = 50;

export function registerChatCommand(program: Command): void {
    const chat = program
        .command('chat')
        .description('chat with FlopsyBot (interactive TUI by default; `chat send` for one-shot)')
        .option('--model <name>', 'override model label shown in header')
        .action(async (opts: { model?: string }) => {
            await runChat(opts.model);
        });

    chat
        .command('send <text...>')
        .description(
            'send one message non-interactively. streams the reply to stdout, exits on done. ' +
            'useful for scripting + automation.',
        )
        .option('--peer <id>', 'override peer id (default: $USER). routes to a specific chat thread.')
        .option('--quiet', 'suppress streaming output; only print the final reply')
        .option('--timeout <seconds>', 'abort if no `done` event by this deadline (default 120)')
        .action(
            async (
                textParts: string[],
                opts: { peer?: string; quiet?: boolean; timeout?: string },
            ) => {
                const text = textParts.join(' ').trim();
                if (!text) {
                    process.stderr.write('error: empty message\n');
                    process.exit(2);
                }
                const timeoutMs = Math.max(
                    1000,
                    (parseInt(opts.timeout ?? '', 10) || 120) * 1000,
                );
                await sendOneShot(text, {
                    peer: opts.peer,
                    quiet: !!opts.quiet,
                    timeoutMs,
                });
            },
        );
}

/**
 * One-shot chat: open the management WebSocket, send one message, stream
 * the reply, exit. Used by automation/scripting and by E1-verify. Exit code:
 *   0 — agent emitted `done`
 *   2 — empty input
 *   3 — timed out before `done`
 *   4 — ws closed before ready / server error event
 *   5 — ws connect/transport error
 */
async function sendOneShot(
    text: string,
    opts: { peer?: string; quiet: boolean; timeoutMs: number },
): Promise<void> {
    const wsUrl = managementUrl('/chat').replace(/^http/, 'ws');
    const peerId =
        opts.peer ?? (() => { try { return userInfo().username; } catch { return 'local'; } })();
    const token = loadMgmtToken();

    const fullUrl =
        `${wsUrl}?user=${encodeURIComponent(peerId)}` +
        (token ? `&token=${encodeURIComponent(token)}` : '');

    let replyBuf = '';
    let gotReady = false;
    let exitCode = 0;

    await new Promise<void>((resolve) => {
        const ws = new WebSocket(fullUrl);
        const timer = setTimeout(() => {
            process.stderr.write(
                `\n[chat send] timeout after ${Math.round(opts.timeoutMs / 1000)}s\n`,
            );
            exitCode = 3;
            try { ws.close(); } catch { /* ignore */ }
            resolve();
        }, opts.timeoutMs);

        ws.addEventListener('open', () => {
            // Wait for `ready` before sending — the channel registers the
            // peer on connection; sending immediately would race that.
        });

        ws.addEventListener('message', (e: MessageEvent) => {
            let ev: ServerEvent;
            try { ev = JSON.parse(String(e.data)) as ServerEvent; } catch { return; }

            if (ev.type === 'ready') {
                gotReady = true;
                if (!opts.quiet) {
                    process.stderr.write(`[chat send] thread=${ev.threadId} model=${ev.model ?? '?'}\n`);
                }
                const msg: ClientMessage = { type: 'message', text };
                ws.send(JSON.stringify(msg));
                return;
            }

            if (ev.type === 'chunk') {
                const c = ev.chunk;
                if (c.type === 'text_delta') {
                    replyBuf += c.text;
                    if (!opts.quiet) process.stdout.write(c.text);
                }
                return;
            }

            if (ev.type === 'done') {
                if (opts.quiet) {
                    process.stdout.write((ev.text ?? replyBuf) + '\n');
                } else {
                    process.stdout.write('\n');
                }
                clearTimeout(timer);
                try { ws.close(); } catch { /* ignore */ }
                resolve();
                return;
            }

            if (ev.type === 'error') {
                process.stderr.write(`\n[chat send] server error: ${ev.message}\n`);
                exitCode = 4;
                clearTimeout(timer);
                try { ws.close(); } catch { /* ignore */ }
                resolve();
                return;
            }
        });

        ws.addEventListener('close', () => {
            if (!gotReady) {
                process.stderr.write('[chat send] ws closed before ready (gateway not running?)\n');
                exitCode = 4;
                clearTimeout(timer);
                resolve();
            }
        });

        ws.addEventListener('error', () => {
            // The 'close' handler runs right after with a useful message;
            // suppress this one to avoid double-printing.
            exitCode = 5;
        });
    });

    process.exit(exitCode);
}

async function runChat(modelOverride?: string): Promise<void> {
    const wsUrl = managementUrl('/chat').replace(/^http/, 'ws');
    const username = (() => { try { return userInfo().username; } catch { return 'local'; } })();
    const token = loadMgmtToken();

    const fullUrl = `${wsUrl}?user=${encodeURIComponent(username)}` +
        (token ? `&token=${encodeURIComponent(token)}` : '');

    const toolStarts  = new Map<string, number>();
    let textBuf = '';

    let ws: WebSocket | null = null;
    let tui!: ChatTUI;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let everConnected = false;
    let quitting = false;
    let welcomed = false;
    // Outbound queue for messages typed while WS is closed/reconnecting.
    // Drained on the next 'open' event. Cap protects against unbounded growth
    // if the gateway is gone for a long time.
    const pending: ClientMessage[] = [];

    // Single teardown path. Idempotent so it's safe to call from an explicit
    // quit, a signal, an uncaught error, AND the `exit` handler. Restores the
    // terminal (cursor, raw mode, bracketed paste) via tui.stop() — without
    // this, any non-clean exit leaves the user's shell unusable until `reset`.
    let cleanedUp = false;
    function cleanup(): void {
        if (cleanedUp) return;
        cleanedUp = true;
        quitting = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        try { ws?.close(); } catch { /* */ }
        try { tui.stop(); } catch { /* */ }
    }

    const send = (msg: ClientMessage): void => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
            return;
        }
        // Interrupts only matter when there's a live turn to interrupt — no
        // point queueing for delivery against a future session.
        if (msg.type === 'interrupt') return;

        if (pending.length >= MAX_PENDING_MESSAGES) {
            tui.addError(`pending queue full (${MAX_PENDING_MESSAGES}) — message dropped`);
            return;
        }
        pending.push(msg);
        tui.addError(`gateway offline — queued (${pending.length} pending)`);
    };

    tui = new ChatTUI({
        onSend({ display, expanded, pastes }) {
            // Local slash commands. Match on the first token so trailing args
            // or whitespace never break a command (e.g. "/clear ", "/help me").
            // Slash commands carry no pastes, so display === expanded.
            const cmd = expanded.trim().split(/\s+/)[0] ?? '';
            switch (cmd) {
                case '/exit':
                case '/quit':
                    cleanup();
                    process.exit(0);
                    return;
                case '/clear':
                    tui.clear();
                    return;
                case '/status':
                    tui.addAssistantText('Fetching gateway status…');
                    send({ type: 'status' });
                    return;
                case '/tasks':
                    tui.addAssistantText('Fetching task list…');
                    send({ type: 'tasks' });
                    return;
                case '/compact':
                    send({ type: 'compact' });
                    tui.addAssistantText('Compacting conversation context…');
                    return;
                case '/new':
                    send({ type: 'new' });
                    tui.clear();
                    return;
                case '/help':
                    tui.addAssistantText(`Local slash commands:\n  /exit, /quit — Close the chat\n  /clear       — Clear the screen\n  /status      — Gateway health snapshot\n  /tasks       — Active background tasks\n  /compact     — Summarise + free context\n  /new         — Start a fresh session\n  /help        — Show this list`);
                    return;
            }
            textBuf = '';
            // Display the collapsed form (with `[Pasted text #N]` tags) in
            // chat history, but send the FULL expanded text to the agent.
            // `pastes` is the id→content map so Ctrl+O can later expand the
            // placeholders shown in history.
            tui.addUserMessage(display, pastes);
            tui.setStreaming(true);
            send({ type: 'message', text: expanded });
        },
        onInterrupt() {
            send({ type: 'interrupt' });
            tui.setStreaming(false);
        },
        onQuit() {
            cleanup();
            process.exit(0);
        },
    });

    // cwd + git branch are fixed for the session — resolve once instead of
    // shelling out on every message. Branch resolves async; setBranch repaints.
    tui.setCwd(process.cwd());
    void detectGitBranch(process.cwd()).then((b) => tui.setBranch(b));

    function connect(): void {
        try {
            ws = new WebSocket(fullUrl);
        } catch {
            process.stderr.write('WebSocket not available — requires Node.js 22+\n');
            process.exit(1);
        }

        ws.addEventListener('open', () => {
            const wasReconnect = everConnected;
            everConnected = true;
            reconnectAttempt = 0;
            if (!wasReconnect) {
                tui.start();
            } else {
                tui.addError('reconnected');
            }
            // Drain any messages typed while we were offline. Send oldest
            // first so the conversation stays in order.
            while (pending.length > 0 && ws?.readyState === WebSocket.OPEN) {
                const msg = pending.shift()!;
                ws.send(JSON.stringify(msg));
            }
        });

        ws.addEventListener('message', (ev: MessageEvent<string>) => {
            let event: ServerEvent;
            try { event = JSON.parse(ev.data) as ServerEvent; } catch { return; }

            switch (event.type) {
                case 'ready':
                    // Only the first ready paints the welcome box — a reconnect
                    // re-emits ready, and a second box mid-history is noise.
                    if (!welcomed) {
                        welcomed = true;
                        tui.showWelcome(event.threadId, modelOverride ?? event.model ?? 'flopsy');
                    }
                    break;

                case 'chunk': {
                    const c = event.chunk;
                    if (c.type === 'text_delta') {
                        if (!textBuf) tui.setStreaming(true);
                        textBuf += c.text;
                        tui.streamAssistantDelta(c.text);
                        break;
                    }
                    if (c.type === 'thinking')    { tui.streamThinking(c.text); break; }
                    if (c.type === 'tool_start')  {
                        toolStarts.set(c.toolName, Date.now());
                        tui.addToolStart(c.toolName, c.args);
                        break;
                    }
                    if (c.type === 'tool_result') {
                        const start = toolStarts.get(c.toolName) ?? Date.now();
                        toolStarts.delete(c.toolName);
                        tui.addToolDone(c.toolName, Date.now() - start, c.result);
                        break;
                    }
                    break;
                }

                case 'task':
                    tui.addTaskEvent(event.event, event.taskId, event.description ?? event.result ?? event.error);
                    break;

                case 'done':
                    if (textBuf || event.text) {
                        tui.addAssistantText(event.text ?? textBuf);
                    }
                    if (event.usage) {
                        const u = event.usage;
                        tui.setTokens(u.input, u.output, u.reasoning, u.cached);
                        if (u.contextTokens !== undefined) {
                            const limit = (u.contextLimit !== undefined && u.contextLimit > 0)
                                ? u.contextLimit
                                : null;
                            tui.setContextUsage(u.contextTokens, limit);
                        }
                    }
                    textBuf = '';
                    tui.setStreaming(false);
                    break;

                case 'compaction':
                    tui.addCompaction({
                        tokensBefore: event.tokensBefore,
                        tokensAfter: event.tokensAfter,
                        durationMs: event.durationMs,
                        strategy: event.strategy,
                    });
                    break;

                case 'error':
                    tui.addError(event.message);
                    textBuf = '';
                    tui.setStreaming(false);
                    break;
            }
        });

        ws.addEventListener('error', () => {
            if (!everConnected) {
                process.stderr.write(`Cannot connect to gateway at ${wsUrl}\nMake sure FlopsyBot is running.\n`);
                process.exit(1);
            }
            // 'error' fires before 'close'; let the 'close' handler schedule reconnect.
        });

        ws.addEventListener('close', () => {
            if (quitting) return;
            tui.setStreaming(false);
            tui.resetState();
            if (everConnected) {
                const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
                tui.addError(`gateway disconnected — reconnecting in ${Math.round(delay / 1000)}s`);
                reconnectAttempt++;
                if (reconnectTimer) clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(connect, delay);
            }
        });
    }

    connect();

    // Restore the terminal on every exit path. SIGINT is handled in-band by
    // the raw-mode input handler (Ctrl+C arms-then-quits); these cover the
    // paths that would otherwise skip teardown — kill, terminal close, and
    // uncaught errors.
    const fatal = (label: string, detail: unknown): void => {
        cleanup();
        const msg = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail);
        process.stderr.write(`\n${label}: ${msg}\n`);
        process.exit(1);
    };
    process.on('exit', cleanup);
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });
    process.on('SIGHUP', () => { cleanup(); process.exit(129); });
    process.on('uncaughtException', (err) => fatal('fatal', err));
    process.on('unhandledRejection', (reason) => fatal('fatal', reason));

    // Keep process alive until the TUI exits
    await new Promise<void>((resolve) => {
        process.on('exit', resolve);
    });
}
