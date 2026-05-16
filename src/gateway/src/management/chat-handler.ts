import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { userInfo } from 'node:os';
import { createLogger } from '@flopsy/shared';
import type { Message } from '@gateway/types';
import type { ChatChannel, ChatSendFn } from '@gateway/channels/chat';
import { validateToken, isSafeIdentifier } from '@gateway/core/security';

const log = createLogger('chat-handler');

const MAX_INBOUND_TEXT = 50_000;

type ClientMessage =
    | { type: 'message'; text: string }
    | { type: 'interrupt' }
    | { type: 'status' }
    | { type: 'tasks' }
    | { type: 'compact' }
    | { type: 'new' };

/** WebSocket adapter for the `flopsy chat` CLI TUI. */
export class ChatHandler {
    private readonly wss: WebSocketServer;
    private readonly token?: string;
    private readonly channel: ChatChannel;

    constructor(channel: ChatChannel, opts: { token?: string } = {}) {
        this.channel = channel;
        this.token = opts.token;
        this.wss = new WebSocketServer({ noServer: true });
        this.wss.on('connection', (ws, req) => this.session(ws, req as IncomingMessage));
    }

    handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/chat') {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }
        if (this.token) {
            const provided =
                url.searchParams.get('token') ??
                (req.headers['authorization'] ?? '').replace(/^Bearer /, '');
            if (!validateToken(this.token, provided)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    }

    private session(ws: WebSocket, req: IncomingMessage): void {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const requested = url.searchParams.get('user');
        const peerId =
            requested && isSafeIdentifier(requested, 64)
                ? requested
                : (() => { try { return userInfo().username; } catch { return 'local'; } })();

        const threadId = `chat:dm:${peerId}`;

        const send: ChatSendFn = (ev) => {
            if (ws.readyState === 1) try { ws.send(JSON.stringify(ev)); } catch { /**/ }
        };

        this.channel.registerPeer(peerId, ws, send);
        const model = this.channel.getMainModel();
        send({ type: 'ready', threadId, ...(model ? { model } : {}) });
        log.debug({ threadId }, 'cli chat connected');

        // Heartbeat: ping every 30s so long-running agent turns (80s+) don't get
        // silently dropped by load balancers or OS idle-connection timeouts.
        const pingInterval = setInterval(() => {
            if (ws.readyState === 1) {
                try { ws.ping(); } catch { /* ignore — close handler will clean up */ }
            }
        }, 30_000);

        ws.on('message', (data) => {
            let msg: ClientMessage;
            try { msg = JSON.parse(data.toString()) as ClientMessage; } catch { return; }

            if (msg.type === 'interrupt') {
                // Synthetic 'stop' so ChannelWorker.dispatch's abort path fires.
                this.channel.dispatchInbound({
                    id: `chat-int-${Date.now()}`,
                    channelName: 'chat',
                    peer: { id: peerId, type: 'user', name: peerId },
                    body: 'stop',
                    timestamp: new Date().toISOString(),
                });
                return;
            }

            if (msg.type === 'message') {
                const text = (msg.text ?? '').replace(/\0/g, '').slice(0, MAX_INBOUND_TEXT);
                const inbound: Message = {
                    id: `chat-${Date.now()}`,
                    channelName: 'chat',
                    peer: { id: peerId, type: 'user', name: peerId },
                    body: text,
                    timestamp: new Date().toISOString(),
                };
                this.channel.dispatchInbound(inbound);
                return;
            }

            // Route slash-type messages through the channel's command dispatcher so
            // the channel-worker resolves the session threadId before calling queryStatus.
            // This is the same path as typing "/status" as a regular message.
            const slashBody: string | null =
                msg.type === 'status'  ? '/status'  :
                msg.type === 'tasks'   ? '/tasks'   :
                msg.type === 'compact' ? '/compact' :
                msg.type === 'new'     ? '/new'     :
                null;
            if (slashBody) {
                this.channel.dispatchInbound({
                    id: `chat-${msg.type}-${Date.now()}`,
                    channelName: 'chat',
                    peer: { id: peerId, type: 'user', name: peerId },
                    body: slashBody,
                    timestamp: new Date().toISOString(),
                });
            }
        });

        ws.on('close', () => {
            clearInterval(pingInterval);
            this.channel.unregisterPeer(peerId);
            log.debug({ threadId }, 'cli chat disconnected');
        });

        ws.on('error', (err) => log.warn({ err, threadId }, 'chat ws error'));
    }
}
