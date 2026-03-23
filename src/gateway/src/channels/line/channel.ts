import type { Peer, OutboundMessage, ReactionOptions, Message } from '@gateway/types';
import { BaseChannel } from '@gateway/core/base-channel';
import type { LineChannelConfig } from './types';

export class LineChannel extends BaseChannel {
    readonly name = 'line';
    readonly authType = 'token' as const;

    private client: import('@line/bot-sdk').messagingApi.MessagingApiClient | null = null;
    private readonly channelConfig: LineChannelConfig;

    constructor(config: LineChannelConfig) {
        super(config);
        this.channelConfig = config;
    }

    async connect(): Promise<void> {
        this.setStatus('connecting');

        try {
            const line = await import('@line/bot-sdk');

            this.client = new line.messagingApi.MessagingApiClient({
                channelAccessToken: this.channelConfig.channelAccessToken,
            });

            await this.client.getBotInfo();
            this.setStatus('connected');
            this.emit('onAuthUpdate', 'authenticated');
        } catch (err) {
            this.setStatus('error');
            this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
    }

    async disconnect(): Promise<void> {
        this.client = null;
        this.setStatus('disconnected');
    }

    async send(message: OutboundMessage): Promise<string> {
        if (!this.client) throw new Error('LINE not connected');

        const to = message.peer.id;
        const messages: Array<{ type: string; text?: string; originalContentUrl?: string; previewImageUrl?: string }> = [];

        if (message.media?.length) {
            for (const media of message.media) {
                switch (media.type) {
                    case 'image':
                        messages.push({
                            type: 'image',
                            originalContentUrl: media.url ?? '',
                            previewImageUrl: media.url ?? '',
                        });
                        break;
                    case 'video':
                        messages.push({
                            type: 'video',
                            originalContentUrl: media.url ?? '',
                            previewImageUrl: media.url ?? '',
                        });
                        break;
                    case 'audio':
                        messages.push({ type: 'audio', originalContentUrl: media.url ?? '' });
                        break;
                    default:
                        if (media.fileName) {
                            messages.push({ type: 'text', text: `[File: ${media.fileName}]` });
                        }
                }
            }
        }

        if (message.body?.trim()) {
            messages.push({ type: 'text', text: message.body });
        }

        if (messages.length === 0) return '';

        await this.client.pushMessage({ to, messages: messages as never });
        return `line-${Date.now()}`;
    }

    async sendTyping(_peer: Peer): Promise<void> {}

    async react(_options: ReactionOptions): Promise<void> {}

    async handleWebhookEvent(event: { type: string; source?: { userId?: string; groupId?: string; type?: string }; message?: { id?: string; text?: string; type?: string }; timestamp?: number; replyToken?: string }): Promise<void> {
        if (event.type !== 'message' || event.message?.type !== 'text') return;

        const source = event.source;
        if (!source) return;

        const isGroup = source.type === 'group';
        const peerId = isGroup ? (source.groupId ?? '') : (source.userId ?? '');
        const senderId = source.userId ?? '';
        const peerType = isGroup ? 'group' as const : 'user' as const;

        if (!this.isAllowed(isGroup ? peerId : senderId, peerType)) return;

        const normalized: Message = {
            id: event.message?.id ?? '',
            channelName: this.name,
            peer: { id: peerId, type: peerType },
            sender: { id: senderId },
            body: event.message?.text ?? '',
            timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
        };

        await this.emit('onMessage', normalized);
    }
}
