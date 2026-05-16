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
    | { type: 'done'; text: string | null; usage?: { input: number; output: number; reasoning?: number; cached?: number; contextTokens?: number; contextLimit?: number } }
    | { type: 'compaction'; threadId: string; tokensBefore: number; tokensAfter: number; threshold: number; strategy: 'clear-tools' | 'summarize' | 'both'; durationMs: number }
    | { type: 'error'; message: string };

export type ChatSendFn = (event: ChatWsEvent) => void;

const WS_OPEN = 1;

export class ChatPeerUnavailableError extends Error {
    constructor(public readonly peerId: string, public readonly reason: 'no-session' | 'ws-closed') {
        super(`chat peer "${peerId}" unavailable: ${reason}`);
        this.name = 'ChatPeerUnavailableError';
    }
}

/** First-class channel for the `flopsy chat` CLI TUI. */
export class ChatChannel extends BaseChannel {
    readonly name = 'chat';
    readonly authType = 'none' as const;

    private readonly peers = new Map<string, { ws: WebSocket; send: ChatSendFn }>();

    /** Per-peer token usage — set by channel-worker after agent turn, flushed on next done. */
    private readonly pendingUsage = new Map<string, { input: number; output: number; reasoning?: number; cached?: number; contextTokens?: number; contextLimit?: number }>();

    /** Store token + context usage for a peer to be sent with the next done event. */
    setPeerUsage(peerId: string, usage: { input: number; output: number; reasoning?: number; cached?: number; contextTokens?: number; contextLimit?: number }): void {
        this.pendingUsage.set(peerId, usage);
    }

    /** Push a compaction event live to the peer's TUI. */
    notifyCompaction(peerId: string, event: { threadId: string; tokensBefore: number; tokensAfter: number; threshold: number; strategy: 'clear-tools' | 'summarize' | 'both'; durationMs: number }): void {
        const session = this.peers.get(peerId);
        if (!session || session.ws.readyState !== WS_OPEN) return;
        session.send({ type: 'compaction', ...event });
    }

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
        if (!session) {
            this.log.warn(
                { peerId: message.peer.id, bodyLen: (message.body ?? '').length },
                'chat send: peer has no live WS session — dropping reply',
            );
            throw new ChatPeerUnavailableError(message.peer.id, 'no-session');
        }
        if (session.ws.readyState !== WS_OPEN) {
            this.peers.delete(message.peer.id);
            this.log.warn(
                { peerId: message.peer.id, readyState: session.ws.readyState, bodyLen: (message.body ?? '').length },
                'chat send: WS not OPEN — dropping reply and unregistering peer',
            );
            throw new ChatPeerUnavailableError(message.peer.id, 'ws-closed');
        }
        const usage = this.pendingUsage.get(message.peer.id);
        this.pendingUsage.delete(message.peer.id);
        session.send({ type: 'done', text: message.body ?? null, ...(usage ? { usage } : {}) });
        return `ws:${message.peer.id}`;
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

    // Chunks are best-effort — final send({type:'done', ...}) carries the full text.
    // Never evict the peer here: a transient non-OPEN state (e.g. mid-reconnect)
    // would kill the peer registration so the final 'done' delivery also fails.
    forwardChunk(peer: Peer, chunk: AgentChunk): void {
        const session = this.peers.get(peer.id);
        if (!session) {
            this.log.debug({ peerId: peer.id }, 'chat forwardChunk: no session — chunk dropped');
            return;
        }
        if (session.ws.readyState !== WS_OPEN) {
            this.log.debug({ peerId: peer.id, readyState: session.ws.readyState }, 'chat forwardChunk: WS not OPEN — chunk dropped');
            return;
        }
        session.send({ type: 'chunk', chunk });
    }

    forwardTaskEvent(
        peer: Peer,
        event: { event: 'start' | 'progress' | 'complete' | 'error'; taskId: string; description?: string; result?: string; error?: string },
    ): void {
        const session = this.peers.get(peer.id);
        if (!session) {
            this.log.debug({ peerId: peer.id, taskId: event.taskId }, 'chat forwardTaskEvent: no session — event dropped');
            return;
        }
        if (session.ws.readyState !== WS_OPEN) {
            this.log.debug({ peerId: peer.id, taskId: event.taskId, readyState: session.ws.readyState }, 'chat forwardTaskEvent: WS not OPEN — event dropped');
            return;
        }
        session.send({ type: 'task', ...event });
    }
}
