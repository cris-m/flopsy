import type { IncomingMessage } from 'node:http';
import type {
    Peer,
    OutboundMessage,
    ReactionOptions,
    Message,
    Media,
    WebhookChannel,
} from '@gateway/types';
import { isTextDocument } from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import { verifyWebhookSignature } from '@gateway/core/security';
import { resolveMediaSource } from '@gateway/core/media-resolver';
import type { LineChannelConfig } from './types';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_DOCUMENT_BYTES = 256 * 1024;

export class LineChannel extends BaseChannel implements WebhookChannel {
    readonly name = 'line';
    readonly authType = 'token';
    readonly rendersCodeBlocks = false;
    readonly webhookPath: string;

    private client: import('@line/bot-sdk').messagingApi.MessagingApiClient | null = null;
    private blobClient: import('@line/bot-sdk').messagingApi.MessagingApiBlobClient | null = null;
    private readonly channelConfig: LineChannelConfig;

    constructor(config: LineChannelConfig) {
        super(config);
        this.channelConfig = config;
        this.webhookPath = config.webhookPath ?? '/webhook/line';
    }

    verifyWebhook(req: IncomingMessage, body: string | Buffer): boolean {
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
                const resolved = await resolveMediaSource(media);
                if (!resolved.ok) {
                    this.log.warn(
                        { to, mediaType: media.type, mediaUrl: media.url, reason: resolved.reason, detail: resolved.detail, op: 'send:media:rejected' },
                        'line send: media resolution failed — skipping attachment',
                    );
                    continue;
                }
                // Line's messaging API ONLY accepts public HTTPS URLs for
                // image/video/audio (no inline upload, no file path). If
                // the agent gave us a local path or a base64 buffer we
                // can't deliver it — log a clear reason instead of silently
                // dropping. Future improvement: stage local files to a
                // public URL via a CDN or the gateway's webhook host.
                if (resolved.source.kind !== 'remote-url') {
                    this.log.warn(
                        {
                            to,
                            mediaType: media.type,
                            sourceKind: resolved.source.kind,
                            reason: 'line-requires-public-https',
                            op: 'send:media:rejected',
                        },
                        'line send: media must be a public HTTPS URL — local paths and inline data not supported. Stage to a CDN first.',
                    );
                    continue;
                }
                const url = resolved.source.url.toString();
                switch (media.type) {
                    case 'image':
                        messages.push({
                            type: 'image',
                            originalContentUrl: url,
                            previewImageUrl: url,
                        });
                        break;
                    case 'video':
                        messages.push({
                            type: 'video',
                            originalContentUrl: url,
                            previewImageUrl: url,
                        });
                        break;
                    case 'audio':
                        messages.push({ type: 'audio', originalContentUrl: url });
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

    /** No-op — the LINE Messaging API does not expose a bot-side reactions
     *  endpoint as of @line/bot-sdk 10.x. Not advertised in capabilities. */
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
                let totalBytes = 0;
                let overLimit = false;
                // Stream-check the running total per chunk instead of
                // buffering the whole image then checking. A malicious
                // or just-large 50 MB image would otherwise sit fully
                // in RAM before the MAX_IMAGE_BYTES check rejected it.
                // We accumulate up to MAX_IMAGE_BYTES + one chunk, then
                // mark overLimit and stop collecting (still drain the
                // stream so the upstream isn't left hanging).
                for await (const chunk of stream as AsyncIterable<Buffer>) {
                    totalBytes += chunk.length;
                    if (totalBytes > MAX_IMAGE_BYTES) {
                        overLimit = true;
                        chunks.length = 0;
                        // Destroy the upstream so we stop pulling bytes
                        // immediately instead of draining the rest.
                        (stream as unknown as { destroy?: (err?: Error) => void }).destroy?.(
                            new Error('over MAX_IMAGE_BYTES'),
                        );
                        break;
                    }
                    chunks.push(chunk);
                }
                if (overLimit) {
                    media.push({ type: 'image' });
                } else {
                    const buffer = Buffer.concat(chunks);
                    media.push({ type: 'image', data: buffer.toString('base64'), mimeType: 'image/jpeg' });
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

        if (msgType === 'file' && m.id && this.blobClient) {
            const fileMsg = m as { id?: string; fileName?: string; fileSize?: number };
            const fileName = fileMsg.fileName;
            const fileSize = fileMsg.fileSize;
            const isText = isTextDocument(undefined, fileName);
            const withinSize = !fileSize || fileSize <= MAX_TEXT_DOCUMENT_BYTES;
            if (isText && withinSize) {
                try {
                    const stream = await this.blobClient.getMessageContent(m.id);
                    const chunks: Buffer[] = [];
                    let total = 0;
                    let over = false;
                    for await (const chunk of stream as AsyncIterable<Buffer>) {
                        total += chunk.length;
                        if (total > MAX_TEXT_DOCUMENT_BYTES) {
                            over = true;
                            chunks.length = 0;
                            (stream as unknown as { destroy?: (err?: Error) => void }).destroy?.(
                                new Error('over MAX_TEXT_DOCUMENT_BYTES'),
                            );
                            break;
                        }
                        chunks.push(chunk);
                    }
                    if (over) {
                        media.push({ type: 'document', fileName, fileSize });
                    } else {
                        const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
                        media.push({ type: 'document', fileName, fileSize, text });
                    }
                } catch {
                    media.push({ type: 'document', fileName, fileSize });
                }
            } else {
                media.push({ type: 'document', fileName, fileSize });
            }
            if (!body) { body = `[File: ${fileName ?? 'attachment'}]`; synthetic = true; }
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
