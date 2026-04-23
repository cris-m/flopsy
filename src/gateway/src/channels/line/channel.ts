import type { IncomingMessage } from 'node:http';
import type {
    Peer,
    OutboundMessage,
    ReactionOptions,
    Message,
    Media,
    WebhookChannel,
} from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import { isSafeMediaUrl, verifyWebhookSignature } from '@gateway/core/security';
import type { LineChannelConfig } from './types';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class LineChannel extends BaseChannel implements WebhookChannel {
    readonly name = 'line';
    readonly authType = 'token';
    readonly webhookPath: string;

    private client: import('@line/bot-sdk').messagingApi.MessagingApiClient | null = null;
    private blobClient: import('@line/bot-sdk').messagingApi.MessagingApiBlobClient | null = null;
    private readonly channelConfig: LineChannelConfig;

    constructor(config: LineChannelConfig) {
        super(config);
        this.channelConfig = config;
        this.webhookPath = config.webhookPath ?? '/webhook/line';
    }

    verifyWebhook(req: IncomingMessage, body: string): boolean {
        const secret = this.channelConfig.channelSecret;
        if (!secret) return true;
        const sig = req.headers['x-line-signature'] as string | undefined;
        if (!sig) return false;
        return verifyWebhookSignature(secret, body, sig, { algorithm: 'sha256', format: 'base64' });
    }

    extractEvents(parsed: unknown): unknown[] {
        if (!parsed || typeof parsed !== 'object') return [];
        const events = (parsed as { events?: unknown[] }).events;
        return Array.isArray(events) ? events : [];
    }

    async connect(): Promise<void> {
        this.setStatus('connecting');

        try {
            const line = await import('@line/bot-sdk');

            this.client = new line.messagingApi.MessagingApiClient({
                channelAccessToken: this.channelConfig.channelAccessToken,
            });
            this.blobClient = new line.messagingApi.MessagingApiBlobClient({
                channelAccessToken: this.channelConfig.channelAccessToken,
            });

            await this.client.getBotInfo();
            this.setStatus('connected');
            this.emit('onAuthUpdate', 'authenticated');
        } catch (err) {
            this.setStatus('error');
            this.emitError(toError(err));
        }
    }

    async disconnect(): Promise<void> {
        this.client = null;
        this.blobClient = null;
        this.setStatus('disconnected');
    }

    async send(message: OutboundMessage): Promise<string> {
        if (!this.client) throw new Error('LINE not connected');

        const to = message.peer.id;
        const messages: Array<{
            type: string;
            text?: string;
            originalContentUrl?: string;
            previewImageUrl?: string;
        }> = [];

        if (message.media?.length) {
            for (const media of message.media) {
                if (!isSafeMediaUrl(media.url)) continue;
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

    async handleWebhookEvent(event: {
        type: string;
        source?: { userId?: string; groupId?: string; type?: string };
        message?: {
            id?: string;
            text?: string;
            type?: string;
            latitude?: number;
            longitude?: number;
            title?: string;
            address?: string;
        };
        timestamp?: number;
        replyToken?: string;
    }): Promise<void> {
        if (event.type !== 'message') return;

        const msgType = event.message?.type;
        const allowedTypes = ['text', 'image', 'video', 'sticker', 'location', 'file'];
        if (!msgType || !allowedTypes.includes(msgType)) return;

        const source = event.source;
        if (!source) return;

        const isGroup = source.type === 'group';
        const peerId = isGroup ? (source.groupId ?? '') : (source.userId ?? '');
        const senderId = source.userId ?? '';
        const peerType = isGroup ? ('group' as const) : ('user' as const);

        if (!this.isAllowed(isGroup ? peerId : senderId, peerType)) return;

        const m = event.message!;
        let body = m.text ?? '';
        let synthetic = false;
        const media: Media[] = [];

        if (msgType === 'location') {
            body = `[Location: lat=${m.latitude}, lon=${m.longitude}${m.title ? `, "${m.title}"` : ''}${m.address ? `, ${m.address}` : ''}]`;
        }

        if (msgType === 'image' && m.id && this.blobClient) {
            try {
                const stream = await this.blobClient.getMessageContent(m.id);
                const chunks: Buffer[] = [];
                for await (const chunk of stream as AsyncIterable<Buffer>) {
                    chunks.push(chunk);
                }
                const buffer = Buffer.concat(chunks);
                if (buffer.length <= MAX_IMAGE_BYTES) {
                    media.push({ type: 'image', data: buffer.toString('base64'), mimeType: 'image/jpeg' });
                } else {
                    media.push({ type: 'image' });
                }
            } catch {
                media.push({ type: 'image' });
            }
            if (!body) { body = '[Image]'; synthetic = true; }
        }

        if (msgType === 'video') {
            media.push({ type: 'video' });
            if (!body) { body = '[Video]'; synthetic = true; }
        }

        if (msgType === 'sticker') {
            media.push({ type: 'sticker' });
            if (!body) { body = '[Sticker]'; synthetic = true; }
        }

        if (!body && media.length === 0) return;

        const normalized: Message = {
            id: m.id ?? '',
            channelName: this.name,
            peer: { id: peerId, type: peerType },
            sender: { id: senderId },
            body,
            synthetic: synthetic || undefined,
            timestamp: event.timestamp
                ? new Date(event.timestamp).toISOString()
                : new Date().toISOString(),
            media: media.length > 0 ? media : undefined,
        };

        await this.emit('onMessage', normalized);
    }
}
