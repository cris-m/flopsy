import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { userInfo } from 'node:os';
import { createLogger } from '@flopsy/shared';
import type { Message } from '@gateway/types';
import type { ChatChannel, ChatSendFn } from '@gateway/channels/chat';

const log = createLogger('chat-handler');

type ClientMessage =
    | { type: 'message'; text: string }
    | { type: 'interrupt' };

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
            if (provided !== this.token) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    }

    private session(ws: WebSocket, req: IncomingMessage): void {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const peerId =
            url.searchParams.get('user') ??
            (() => { try { return userInfo().username; } catch { return 'local'; } })();

        const threadId = `chat:dm:${peerId}`;

        const send: ChatSendFn = (ev) => {
            if (ws.readyState === 1) try { ws.send(JSON.stringify(ev)); } catch { /**/ }
        };

        this.channel.registerPeer(peerId, ws, send);
        const model = this.channel.getMainModel();
        send({ type: 'ready', threadId, ...(model ? { model } : {}) });
        log.debug({ threadId }, 'cli chat connected');

        ws.on('message', (data) => {
            let msg: ClientMessage;
            try { msg = JSON.parse(data.toString()) as ClientMessage; } catch { return; }

            if (msg.type === 'interrupt') {
                // ChannelWorker owns the abort signal; TUI handles its own state.
                return;
            }

            if (msg.type === 'message') {
                const inbound: Message = {
                    id: `chat-${Date.now()}`,
                    channelName: 'chat',
                    peer: { id: peerId, type: 'user', name: peerId },
                    body: msg.text,
                    timestamp: new Date().toISOString(),
                };
                this.channel.dispatchInbound(inbound);
            }
        });

        ws.on('close', () => {
            this.channel.unregisterPeer(peerId);
            log.debug({ threadId }, 'cli chat disconnected');
        });

        ws.on('error', (err) => log.warn({ err, threadId }, 'chat ws error'));
    }
}
