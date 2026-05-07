import { type Command } from 'commander';
import { userInfo } from 'node:os';
import { mgmtUrl } from './schedule-client';
import { ChatTUI } from '../ui/chat-tui';

// Wire-protocol types (mirror gateway/src/mgmt/chat-handler.ts — no cross-package import needed)
type AgentChunk =
    | { type: 'text_delta';  text: string }
    | { type: 'thinking';    text: string }
    | { type: 'tool_start';  toolName: string; args?: string }
    | { type: 'tool_result'; toolName: string; result?: string };

type ServerEvent =
    | { type: 'ready';  threadId: string; model?: string }
    | { type: 'chunk';  chunk: AgentChunk }
    | { type: 'task';   event: 'start' | 'progress' | 'complete' | 'error'; taskId: string; description?: string; result?: string; error?: string }
    | { type: 'done';   text: string | null; usage?: { input: number; output: number } }
    | { type: 'error';  message: string };

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
    program
        .command('chat')
        .description('interactive chat with FlopsyBot in the terminal')
        .option('--model <name>', 'override model label shown in header')
        .action(async (opts: { model?: string }) => {
            await runChat(opts.model);
        });
}

async function runChat(modelOverride?: string): Promise<void> {
    const wsUrl = mgmtUrl('/chat').replace(/^http/, 'ws');
    const username = (() => { try { return userInfo().username; } catch { return 'local'; } })();
    const token = process.env['FLOPSY_MGMT_TOKEN'];

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
    // Outbound queue for messages typed while WS is closed/reconnecting.
    // Drained on the next 'open' event. Cap protects against unbounded growth
    // if the gateway is gone for a long time.
    const pending: ClientMessage[] = [];

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
        onSend(text) {
            tui.setCwd(process.cwd());
            // Detect git branch (lightweight, cached in global)
            try {
                const { execSync } = require('child_process');
                const branch = execSync('git branch --show-current 2>/dev/null', {
                    cwd: process.cwd(), encoding: 'utf8', timeout: 1000,
                }).trim();
                if (branch) (globalThis as any).__flopsyGitBranch = `(${branch})`;
                else (globalThis as any).__flopsyGitBranch = '';
            } catch { (globalThis as any).__flopsyGitBranch = ''; }

            // Handle local slash commands
            const trimmed = text.trim();
            if (trimmed === '/exit' || trimmed === '/quit') {
                quitting = true;
                if (reconnectTimer) clearTimeout(reconnectTimer);
                ws?.close();
                tui.stop();
                process.exit(0);
                return;
            }
            if (trimmed === '/clear') {
                tui.clear();
                return;
            }
            if (trimmed.startsWith('/status')) {
                tui.addAssistantText('Fetching gateway status…');
                send({ type: 'status' });
                return;
            }
            if (trimmed.startsWith('/tasks')) {
                tui.addAssistantText('Fetching task list…');
                send({ type: 'tasks' });
                return;
            }
            if (trimmed === '/compact') {
                send({ type: 'compact' });
                tui.addAssistantText('Compacting conversation context…');
                return;
            }
            if (trimmed === '/new') {
                send({ type: 'new' });
                tui.clear();
                return;
            }
            if (trimmed === '/help') {
                tui.addAssistantText(`Local slash commands:\n  /exit, /quit — Close the chat\n  /clear      — Clear the screen\n  /status     — Gateway health snapshot\n  /tasks      — Active background tasks\n  /compact    — Summarise + free context\n  /new        — Start a fresh session\n  /help       — Show this list`);
                return;
            }
            textBuf = '';
            tui.addUserMessage(text);
            tui.setStreaming(true);
            send({ type: 'message', text });
        },
        onInterrupt() {
            send({ type: 'interrupt' });
            tui.setStreaming(false);
        },
        onQuit() {
            quitting = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            ws?.close();
            tui.stop();
            process.exit(0);
        },
    });

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
                    tui.showWelcome(event.threadId, modelOverride ?? event.model ?? 'flopsy');
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
                        const u = event.usage as any;
                        tui.setTokens(event.usage.input, event.usage.output, u.reasoning, u.cached);
                        if (u.contextTokens !== undefined && u.contextLimit !== undefined) {
                            tui.setContextUsage(u.contextTokens, u.contextLimit);
                        }
                    }
                    textBuf = '';
                    tui.setStreaming(false);
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

    // Keep process alive until the TUI exits
    await new Promise<void>((resolve) => {
        process.on('exit', resolve);
    });
}
