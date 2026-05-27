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

export type InteractiveCapability =
    | 'buttons'
    | 'select'
    | 'cards'
    | 'components'
    | 'polls'
    | 'reactions'
    | 'typing'
    | 'edit-message';

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
    text?: string;
}

export const DOCUMENT_TEXT_MIMES: ReadonlySet<string> = new Set([
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/x-log',
    'text/html',
    'text/xml',
    'application/json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/toml',
    'application/javascript',
    'application/typescript',
]);

export const DOCUMENT_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
    'md', 'markdown', 'txt', 'log', 'csv', 'tsv',
    'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'env',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs',
    'sh', 'bash', 'zsh', 'fish',
    'html', 'htm', 'css', 'scss', 'sass', 'less',
    'sql', 'graphql', 'gql', 'proto',
]);

export function isTextDocument(mimeType?: string, fileName?: string): boolean {
    if (mimeType) {
        if (mimeType.startsWith('text/')) return true;
        if (DOCUMENT_TEXT_MIMES.has(mimeType.toLowerCase())) return true;
    }
    if (fileName) {
        const ext = fileName.split('.').pop()?.toLowerCase();
        if (ext && DOCUMENT_TEXT_EXTENSIONS.has(ext)) return true;
    }
    return false;
}

export interface Message {
    id: string;
    channelName: string;
    peer: Peer;
    sender?: { id: string; name?: string };
    body: string;
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

/**
 * Multi-message delivery intent. Replaces in-band delimiters with a typed,
 * auditable contract for "send N messages with natural pacing between."
 *
 * Owned by `BaseChannel.deliverMessages`. The agent expresses intent in
 * exactly one of two ways:
 *   1. Tool path:  send_message({ parts: ['msg 1', 'msg 2', ...] })
 *   2. Free-text path: structured-output { messages: ['msg 1', ...] }
 * Both funnel through deliverMessages, which owns pacing, typing-indicator,
 * replyTo-only-on-first, and per-part error isolation.
 *
 * No in-band delimiters: '---' in a single string remains a markdown
 * thematic break, not a split marker.
 */
export interface DeliverMessagesOptions {
    peer: Peer;
    /** N >= 1 message bodies. Each becomes one channel send. */
    parts: string[];
    /** Applied to parts[0] only — subsequent parts never reply-chain. */
    replyTo?: string;
    /** Pacing between parts. Default scales with part length (≈30ms/char, capped). */
    pauseMs?: number | ((partIndex: number, part: string) => number);
    /** Show the channel's typing indicator between parts (default true). */
    showTyping?: boolean;
    /** Media attached to parts[0] only (typically). */
    media?: Media[];
}

export interface DeliverMessagesResult {
    /** Channel message IDs for each part, in order. Null entries = send failed. */
    messageIds: (string | null)[];
    /** True if every part sent successfully. */
    allSent: boolean;
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
    readonly rendersCodeBlocks?: boolean;

    connect(): Promise<void>;
    disconnect(): Promise<void>;

    send(message: OutboundMessage): Promise<string>;
    sendTyping(peer: Peer): Promise<void>;
    react(options: ReactionOptions): Promise<void>;

    /**
     * Multi-message delivery with pacing + typing-indicator + per-part error
     * isolation. Default implementation composes from `send`/`sendTyping`;
     * channels may override for native batch APIs. See base-channel.ts.
     */
    deliverMessages(opts: DeliverMessagesOptions): Promise<DeliverMessagesResult>;

    /**
     * Per-channel flag — when true, the channel-worker's reasoning lane
     * surfaces agent thinking as a single edit-in-place message. Default
     * false. Wired from `channels.<name>.showThinking` in flopsy.json5.
     */
    readonly showThinking: boolean;

    formatReasoning(content: string): string;

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
    deleteMessage?(messageId: string, peer: Peer): Promise<void>;
    updateAccessControl?(update: AccessControlUpdate): void;
    pairingRequestHandler?: PairingRequestHandler | null;

    forwardChunk?(peer: Peer, chunk: import('./agent').AgentChunk): void;

    /**
     * Per-peer token + context-window usage update. Channels with a status
     * line (Discord embeds, Telegram pinned messages) render this; channels
     * without one ignore it. Optional — most channels don't implement it.
     */
    setPeerUsage?(
        peerId: string,
        usage: {
            input: number;
            output: number;
            reasoning?: number;
            cached?: number;
            contextTokens?: number;
            contextLimit?: number;
        },
    ): void;

    /**
     * Notify the channel that the agent compacted a thread the channel is
     * displaying. Channels with a status line may surface a transient hint;
     * channels without one ignore it. The compaction event type is opaque
     * here to avoid a hard dep on `@flopsy/team`.
     */
    notifyCompaction?(peerId: string, event: unknown): void;

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
    verifyWebhook(req: IncomingMessage, body: string | Buffer): boolean;
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
    /**
     * Show the agent's reasoning ("thinking") on this channel as a single
     * edit-in-place message. Default false — matches Hermes/openclaw
     * industry pattern where reasoning stays in observability logs.
     * Set `channels.<name>.showThinking: true` in flopsy.json5 to enable.
     */
    showThinking?: boolean;
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
    readonly getGatewayStatus?: () => GatewayStatusSnapshot | undefined;
    readonly structuredOutputModel?: unknown;
    readonly reactionPolicy?: {
        readonly direct: boolean;
        readonly group: 'always' | 'mentions' | 'never';
    };
    readonly ackEmoji?: string;
}

export interface GatewayStatusSnapshot {
    readonly uptimeMs: number;
    readonly channels: ReadonlyArray<{
        readonly name: string;
        readonly status: ChannelStatus;
        readonly enabled: boolean;
    }>;
    readonly activeThreads: number;
    readonly port?: number;
    readonly version?: string;
    readonly webhook?: {
        readonly enabled: boolean;
        readonly port?: number;
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
