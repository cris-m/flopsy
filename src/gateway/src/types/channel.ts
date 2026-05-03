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

/** Capability flags each channel declares. */
export type InteractiveCapability =
    | 'buttons'
    | 'select'
    | 'cards'
    | 'components'
    | 'polls'
    | 'reactions'
    | 'typing'
    | 'edit-message';

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

/** Channels without native polls render a numbered-text fallback. */
export interface InteractivePollBlock {
    readonly type: 'poll';
    readonly question: string;
    readonly options: string[];
    readonly anonymous?: boolean;
    readonly allowMultiple?: boolean;
}

export type InteractiveBlock =
    | InteractiveTextBlock
    | InteractiveButtonsBlock
    | InteractiveSelectBlock
    | InteractivePollBlock;

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
    /** True for channel-adapter-generated placeholders ("[Image]", "[Video]"). */
    synthetic?: boolean;
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

    /** Native poll. Leave undefined for fallback to numbered-text via send(). */
    sendPoll?(args: {
        peer: Peer;
        question: string;
        options: readonly string[];
        anonymous?: boolean;
        allowMultiple?: boolean;
        durationHours?: number;
    }): Promise<string>;

    clearSession?(): Promise<void>;
    editMessage?(messageId: string, peer: Peer, body: string): Promise<void>;
    updateAccessControl?(update: AccessControlUpdate): void;
    pairingRequestHandler?: PairingRequestHandler | null;

    /** Hook for channels (e.g. chat TUI) that render raw streaming chunks. */
    forwardChunk?(peer: Peer, chunk: import('./agent').AgentChunk): void;

    /** Hook for channels that render background-task lifecycle events. */
    forwardTaskEvent?(
        peer: Peer,
        event: {
            event: 'start' | 'progress' | 'complete' | 'error';
            taskId: string;
            description?: string;
            result?: string;
            error?: string;
        },
    ): void;

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
    readonly onReply: (
        text: string,
        peer: Peer,
        replyTo?: string,
        options?: {
            readonly buttons?: ReadonlyArray<InteractiveButton>;
            readonly media?: ReadonlyArray<Media>;
        },
    ) => Promise<void>;
    readonly onSendPoll: (
        peer: Peer,
        question: string,
        options: readonly string[],
        pollOptions?: {
            readonly anonymous?: boolean;
            readonly allowMultiple?: boolean;
            readonly durationHours?: number;
        },
    ) => Promise<void>;
    readonly coalesceDelayMs?: number;
    readonly agentTimeoutMs?: number;
    readonly backgroundTurnTimeoutMs?: number;
    /** Lazy `/status` snapshot getter. */
    readonly getGatewayStatus?: () => GatewayStatusSnapshot | undefined;
    /** BaseChatModel for conditional webhook delivery (typed `unknown` to avoid cycle). */
    readonly structuredOutputModel?: unknown;
}

/**
 * User-safe snapshot for chat commands. No tokens / peer ids / URLs / paths —
 * adding fields here is a conscious privacy choice.
 */
export interface GatewayStatusSnapshot {
    readonly uptimeMs: number;
    readonly channels: ReadonlyArray<{
        readonly name: string;
        readonly status: ChannelStatus;
        readonly enabled: boolean;
    }>;
    readonly activeThreads: number;
    /** Host deliberately omitted. */
    readonly port?: number;
    /** Git short-sha or 'dev'. */
    readonly version?: string;
    readonly webhook?: {
        readonly enabled: boolean;
        readonly port?: number;
        /** Route count — paths are not leaked. */
        readonly routeCount: number;
    };
    readonly proactive?: {
        readonly running: boolean;
        readonly heartbeats: number;
        readonly cronJobs: number;
        readonly inboundWebhooks: number;
        readonly lastHeartbeatAt?: number;
    };
}
