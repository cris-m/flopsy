import type { IncomingMessage } from 'node:http';
import type { AgentHandler } from './agent';

export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type AuthState = 'needs_scan' | 'waiting_scan' | 'authenticated' | 'expired' | 'not_configured';

export type DmPolicy = 'pairing' | 'allowlist' | 'open' | 'disabled';

export type GroupPolicy = 'allowlist' | 'open' | 'disabled';

export type GroupActivation = 'mention' | 'always';

export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export interface Peer {
    id: string;
    type: 'user' | 'group' | 'channel';
    name?: string;
}

export interface Media {
    type: MediaType;
    url?: string;
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
    caption?: string;
    data?: string;
}

export interface Message {
    id: string;
    channelName: string;
    peer: Peer;
    sender?: { id: string; name?: string };
    body: string;
    timestamp: string;
    replyTo?: { id: string; body?: string; sender?: string };
    media?: Media[];
}

export interface OutboundMessage {
    peer: Peer;
    body?: string;
    replyTo?: string;
    media?: Media[];
}

export interface ReactionOptions {
    messageId: string;
    peer: Peer;
    emoji: string;
    remove?: boolean;
}

export interface PairingRequest {
    channelName: string;
    senderId: string;
    senderName?: string;
    messagePreview?: string;
    timestamp: number;
}

export type PairingRequestHandler = (request: PairingRequest) => void;

export interface ChannelEvents {
    onMessage: (message: Message) => Promise<void>;
    onStatusChange: (status: ChannelStatus) => void;
    onError: (error: Error) => void;
    onQR: (qrData: string) => void;
    onAuthUpdate: (status: AuthState) => void;
}

export interface AccessControlUpdate {
    dmPolicy?: DmPolicy;
    allowFrom?: string[];
    blockedFrom?: string[];
    groupPolicy?: GroupPolicy;
    allowedGroups?: string[];
}

export type AuthType = 'qr' | 'token' | 'oauth' | 'none';

export interface Channel {
    readonly name: string;
    readonly status: ChannelStatus;
    readonly enabled: boolean;
    readonly dmPolicy: DmPolicy;
    readonly groupPolicy: GroupPolicy;
    readonly authType: AuthType;

    connect(): Promise<void>;
    disconnect(): Promise<void>;

    send(message: OutboundMessage): Promise<string>;
    sendTyping(peer: Peer): Promise<void>;
    react(options: ReactionOptions): Promise<void>;

    clearSession?(): Promise<void>;
    editMessage?(messageId: string, peer: Peer, body: string): Promise<void>;
    updateAccessControl?(update: AccessControlUpdate): void;
    pairingRequestHandler?: PairingRequestHandler | null;

    on<K extends keyof ChannelEvents>(event: K, handler: ChannelEvents[K]): void;
    off<K extends keyof ChannelEvents>(event: K, handler: ChannelEvents[K]): void;
}

/**
 * Channels that receive messages via HTTP webhook implement this interface.
 * The gateway uses it to register a single unified webhook route per channel.
 */
export interface WebhookChannel {
    /** Route path the webhook server listens on (e.g. '/webhook/line'). */
    readonly webhookPath: string;
    /**
     * Verify an inbound request. Return true to accept, false to reject with 401.
     * Channels that don't need verification should always return true.
     */
    verifyWebhook(req: IncomingMessage, body: string): boolean;
    /**
     * Extract events from the parsed JSON body.
     * Returns an array of opaque event objects the channel understands.
     */
    extractEvents(parsed: unknown): unknown[];
    /** Process a single webhook event (normalize → emit onMessage). */
    handleWebhookEvent(event: unknown): Promise<void>;
}

export function isWebhookChannel(ch: Channel): ch is Channel & WebhookChannel {
    return 'webhookPath' in ch && 'handleWebhookEvent' in ch && 'verifyWebhook' in ch;
}

export interface BaseChannelConfig {
    enabled: boolean;
    dmPolicy: DmPolicy;
    groupPolicy?: GroupPolicy;
    allowFrom?: string[];
    blockedFrom?: string[];
    allowedGroups?: string[];
}

export interface ChannelWorkerConfig {
    readonly channel: Channel;
    readonly threadId: string;
    readonly agentHandler: AgentHandler;
    readonly onReply: (text: string, peer: Peer, replyTo?: string) => Promise<void>;
    readonly coalesceDelayMs?: number;
    /** Timeout for regular user turns. Default: 120 000 ms (2 min). */
    readonly agentTimeoutMs?: number;
    /** Timeout for background-task result turns. Default: 600 000 ms (10 min). */
    readonly backgroundTurnTimeoutMs?: number;
}
