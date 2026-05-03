import type { WebSocket } from 'ws';
import type { OutboundMessage, Peer, ReactionOptions, Message, BaseChannelConfig } from '@gateway/types';
import type { AgentChunk } from '@gateway/types/agent';
import { BaseChannel } from '@gateway/core/base-channel';

export interface ChatChannelConfig extends BaseChannelConfig {}

/** Events from gateway WS server → CLI TUI. */
export type ChatWsEvent =
    | { type: 'ready'; threadId: string; model?: string }
    | { type: 'chunk'; chunk: AgentChunk }
    | { type: 'task'; event: 'start' | 'progress' | 'complete' | 'error'; taskId: string; description?: string; result?: string; error?: string }
    | { type: 'done'; text: string | null }
    | { type: 'error'; message: string };

export type ChatSendFn = (event: ChatWsEvent) => void;

/** First-class channel for the `flopsy chat` CLI TUI. */
export class ChatChannel extends BaseChannel {
    readonly name = 'chat';
    readonly authType = 'none' as const;

    private readonly peers = new Map<string, { ws: WebSocket; send: ChatSendFn }>();

    /** Returns the active main-agent model name, when known. */
    getMainModel: () => string | undefined = () => undefined;

    constructor(config: ChatChannelConfig) {
        super(config);
    }

    async connect(): Promise<void> {
        this.setStatus('connected');
    }

    async disconnect(): Promise<void> {
        this.peers.clear();
        this.setStatus('disconnected');
    }

    async send(message: OutboundMessage): Promise<string> {
        const session = this.peers.get(message.peer.id);
        if (!session) return '';
        session.send({ type: 'done', text: message.body ?? null });
        return '';
    }

    async sendTyping(_peer: Peer): Promise<void> {}

    async react(_options: ReactionOptions): Promise<void> {}

    registerPeer(peerId: string, ws: WebSocket, send: ChatSendFn): void {
        this.peers.set(peerId, { ws, send });
        this.log.debug({ peerId }, 'chat peer registered');
    }

    unregisterPeer(peerId: string): void {
        this.peers.delete(peerId);
        this.log.debug({ peerId }, 'chat peer unregistered');
    }

    dispatchInbound(message: Message): void {
        void this.emit('onMessage', message);
    }

    forwardChunk(peer: Peer, chunk: AgentChunk): void {
        const session = this.peers.get(peer.id);
        if (!session) return;
        session.send({ type: 'chunk', chunk });
    }

    forwardTaskEvent(
        peer: Peer,
        event: { event: 'start' | 'progress' | 'complete' | 'error'; taskId: string; description?: string; result?: string; error?: string },
    ): void {
        const session = this.peers.get(peer.id);
        if (!session) return;
        session.send({ type: 'task', ...event });
    }
}
