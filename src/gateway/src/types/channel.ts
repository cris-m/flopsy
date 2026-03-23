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
