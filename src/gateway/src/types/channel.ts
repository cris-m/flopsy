import type { IncomingMessage } from 'node:http';
import type { AgentHandler } from './agent';

export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type AuthState =
    | 'needs_scan'
    | 'waiting_scan'
    | 'authenticated'
    | 'expired'
    | 'not_configured';

export type DmPolicy = 'pairing' | 'allowlist' | 'open' | 'disabled';

export type GroupPolicy = 'allowlist' | 'open' | 'disabled';

export type GroupActivation = 'mention' | 'always';

export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/**
 * Interactive message capability flags.
 * Each channel declares which of these it supports.
 */
export type InteractiveCapability = 'buttons' | 'select' | 'cards' | 'components' | 'polls';

/** Button style for interactive messages. */
export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface InteractiveButton {
    readonly label: string;
    readonly value: string;
    readonly style?: ButtonStyle;
}

export interface InteractiveOption {
    readonly label: string;
    readonly value: string;
}

export interface InteractiveTextBlock {
    readonly type: 'text';
    readonly text: string;
}

export interface InteractiveButtonsBlock {
    readonly type: 'buttons';
    readonly buttons: InteractiveButton[];
}

export interface InteractiveSelectBlock {
    readonly type: 'select';
    readonly placeholder?: string;
    readonly options: InteractiveOption[];
    readonly multiSelect?: boolean;
}

export type InteractiveBlock =
    | InteractiveTextBlock
    | InteractiveButtonsBlock
    | InteractiveSelectBlock;

export interface InteractiveReply {
    readonly blocks: InteractiveBlock[];
}

export interface InteractionCallback {
    readonly type: 'button_click' | 'select_choice';
    readonly value: string;
    readonly messageId: string;
    readonly peer: Peer;
    readonly sender?: { id: string; name?: string };
}

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
    interactive?: InteractiveReply;
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
    onInteraction: (callback: InteractionCallback) => Promise<void>;
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

export interface StreamingCapability {
    readonly editBased: boolean;
    readonly minEditIntervalMs: number;
}

export interface Channel {
    readonly name: string;
    readonly status: ChannelStatus;
    readonly enabled: boolean;
    readonly dmPolicy: DmPolicy;
    readonly groupPolicy: GroupPolicy;
    readonly authType: AuthType;
    readonly streaming?: StreamingCapability;
    readonly capabilities?: readonly InteractiveCapability[];

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

export interface WebhookChannel {
    readonly webhookPath: string;
    verifyWebhook(req: IncomingMessage, body: string): boolean;
    extractEvents(parsed: unknown): unknown[];
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
    readonly agentTimeoutMs?: number;
    readonly backgroundTurnTimeoutMs?: number;
}
