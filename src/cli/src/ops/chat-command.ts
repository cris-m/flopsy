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
    | { type: 'interrupt' };

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

    let ws: WebSocket;
    let tui!: ChatTUI;

    const send = (msg: ClientMessage): void => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    tui = new ChatTUI({
        onSend(text) {
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
            tui.stop();
            process.exit(0);
        },
    });

    try {
        ws = new WebSocket(fullUrl);
    } catch {
        process.stderr.write('WebSocket not available — requires Node.js 22+\n');
        process.exit(1);
    }

    ws.addEventListener('open', () => {
        tui.start();
    });

    ws.addEventListener('message', (ev: MessageEvent<string>) => {
        let event: ServerEvent;
        try { event = JSON.parse(ev.data) as ServerEvent; } catch { return; }

        switch (event.type) {
            case 'ready':
                // Model name precedence: --model flag > server-reported (ready.model) > placeholder.
                tui.showWelcome(event.threadId, modelOverride ?? event.model ?? 'flopsy');
                break;

            case 'chunk': {
                const c = event.chunk;
                if (c.type === 'text_delta')  { textBuf += c.text; break; }
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
                textBuf = '';
                tui.setStreaming(false);   // also resets thinkingActive
                break;

            case 'error':
                tui.addError(event.message);
                textBuf = '';
                tui.setStreaming(false);
                break;
        }
    });

    ws.addEventListener('error', () => {
        if (!tui) {
            process.stderr.write(`Cannot connect to gateway at ${wsUrl}\nMake sure FlopsyBot is running.\n`);
            process.exit(1);
        }
        tui.addError(`connection error — is the gateway running? (${wsUrl})`);
        tui.setStreaming(false);
    });

    ws.addEventListener('close', () => {
        if (tui) {
            tui.addError('gateway disconnected');
            tui.setStreaming(false);
        }
    });

    // Keep process alive until the TUI exits
    await new Promise<void>((resolve) => {
        process.on('exit', resolve);
    });
}
