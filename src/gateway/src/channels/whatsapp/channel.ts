import type {
    WASocket,
    ConnectionState,
    AnyMessageContent,
    WAMessage,
    MiscMessageGenerationOptions,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import type { Peer, OutboundMessage, ReactionOptions, Media } from '@gateway/types';
import { isTextDocument } from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import { isSafeMediaUrl } from '@gateway/core/security';
import type { WhatsAppChannelConfig } from './types';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_DOCUMENT_BYTES = 256 * 1024;

const REPLY_CACHE_MAX = 200;

export class WhatsAppChannel extends BaseChannel {
    readonly name = 'whatsapp';
    readonly authType = 'qr';

    private socket: WASocket | null = null;
    private readonly channelConfig: WhatsAppChannelConfig;
    private connecting = false;
    private readonly replyCache = new Map<string, WAMessage>();

    constructor(config: WhatsAppChannelConfig) {
        super(config);
        this.channelConfig = config;
    }

    async connect(): Promise<void> {
        if (this.socket || this.connecting) return;
        this.connecting = true;

        try {
            this.setStatus('connecting');

            const {
                makeWASocket,
                useMultiFileAuthState,
                makeCacheableSignalKeyStore,
                DisconnectReason,
            } = await import('@whiskeysockets/baileys');
            const pino = (await import('pino')).default;

            const sessionPath = this.channelConfig.sessionPath ?? '.flopsy/sessions/whatsapp';
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const logger = pino({ level: 'silent' });

            this.socket = makeWASocket({
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
                logger,
                printQRInTerminal: false,
            });

            this.socket.ev.on('creds.update', saveCreds);

            this.socket.ev.on('connection.update', (update: Partial<ConnectionState>) => {
                if (update.qr) this.emit('onQR', update.qr);

                if (update.connection === 'open') {
                    this.reconnectAttempts = 0;
                    this.setStatus('connected');
                    this.emit('onAuthUpdate', 'authenticated');
                }

                if (update.connection === 'close') {
                    this.socket = null;
                    const statusCode = (update.lastDisconnect?.error as Boom)?.output?.statusCode;

                    if (statusCode === DisconnectReason.loggedOut) {
                        this.setStatus('disconnected');
                        this.emit('onAuthUpdate', 'expired');
                        return;
                    }

                    this.scheduleReconnect();
                }
            });

            this.socket.ev.on('messages.upsert', async ({ messages }) => {
                await Promise.allSettled(messages.map(async (msg) => {
                    try {
                        if (!msg.message || msg.key.fromMe) return;

                        const senderId = msg.key.remoteJid ?? '';
                        const isGroup = senderId.endsWith('@g.us');
                        const peerType = isGroup ? ('group' as const) : ('user' as const);

                        if (!this.isAllowed(senderId, peerType)) return;

                        if (msg.key.id) {
                            this.replyCache.set(msg.key.id, msg);
                            if (this.replyCache.size > REPLY_CACHE_MAX) {
                                const oldest = this.replyCache.keys().next().value;
                                if (oldest) this.replyCache.delete(oldest);
                            }
                        }

                        if (this.channelConfig.sendReadReceipts !== false) {
                            void this.socket?.readMessages([msg.key]).catch(() => {});
                        }

                        const m = msg.message;
                        let body =
                            m.conversation ??
                            m.extendedTextMessage?.text ??
                            m.imageMessage?.caption ??
                            '';

                        const media: Media[] = [];
                        let synthetic = false;

                        if (m.locationMessage) {
                            const loc = m.locationMessage;
                            const name = (loc as { name?: string }).name;
                            body = `[Location: lat=${loc.degreesLatitude}, lon=${loc.degreesLongitude}${name ? `, "${name}"` : ''}]${body ? ' ' + body : ''}`;
                        }

                        if (m.imageMessage) {
                            try {
                                const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
                                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                                if (buffer instanceof Buffer && buffer.length <= MAX_IMAGE_BYTES) {
                                    media.push({
                                        type: 'image',
                                        data: buffer.toString('base64'),
                                        mimeType: m.imageMessage.mimetype ?? 'image/jpeg',
                                    });
                                } else {
                                    media.push({ type: 'image', mimeType: m.imageMessage.mimetype ?? 'image/jpeg' });
                                }
                            } catch {
                                media.push({ type: 'image', mimeType: m.imageMessage.mimetype ?? 'image/jpeg' });
                            }
                            if (!body) { body = '[Image]'; synthetic = true; }
                        }

                        if (m.documentMessage) {
                            const doc = m.documentMessage;
                            const fileName = doc.fileName ?? undefined;
                            const mimeType = doc.mimetype ?? undefined;
                            const fileSize = typeof doc.fileLength === 'number' ? doc.fileLength : undefined;
                            const isText = isTextDocument(mimeType, fileName);
                            const withinSize = !fileSize || fileSize <= MAX_TEXT_DOCUMENT_BYTES;
                            if (isText && withinSize) {
                                try {
                                    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
                                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                                    if (buffer instanceof Buffer && buffer.length <= MAX_TEXT_DOCUMENT_BYTES) {
                                        const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
                                        media.push({ type: 'document', fileName, mimeType, fileSize, text });
                                    } else {
                                        media.push({ type: 'document', fileName, mimeType, fileSize });
                                    }
                                } catch {
                                    media.push({ type: 'document', fileName, mimeType, fileSize });
                                }
                            } else {
                                media.push({ type: 'document', fileName, mimeType, fileSize });
                            }
                            if (!body) { body = `[Document: ${fileName ?? mimeType ?? 'file'}]`; synthetic = true; }
                        }

                        if (m.videoMessage) {
                            media.push({ type: 'video', mimeType: m.videoMessage.mimetype ?? undefined });
                            if (!body) { body = '[Video]'; synthetic = true; }
                        }

                        if (!body && media.length === 0) return;

                        await this.emit('onMessage', {
                            id: msg.key.id ?? '',
                            channelName: this.name,
                            peer: { id: senderId, type: peerType },
                            sender: msg.key.participant ? { id: msg.key.participant } : undefined,
                            body,
                            synthetic: synthetic || undefined,
                            timestamp: new Date(
                                (msg.messageTimestamp as number) * 1000,
                            ).toISOString(),
                            media: media.length > 0 ? media : undefined,
                        });
                    } catch (err) {
                        this.emitError(toError(err));
                    }
                }));
            });
        } catch (err) {
            this.setStatus('error');
            this.emitError(toError(err));
            if (this.socket) {
                try {
                    (this.socket as { end?: (err?: unknown) => void }).end?.(undefined);
                } catch { /* best-effort */ }
                this.socket = null;
            }
        } finally {
            this.connecting = false;
        }
    }

    async clearSession(): Promise<void> {
        if (!this.channelConfig.sessionPath) return;
        const { rm } = await import('fs/promises');
        await rm(this.channelConfig.sessionPath, { recursive: true, force: true }).catch(
            (err: unknown) => {
                this.log.warn(
                    { err, path: this.channelConfig.sessionPath, op: 'clearSession' },
                    'whatsapp session cleanup failed — next reconnect may inherit stale auth',
                );
            },
        );
    }

    async disconnect(): Promise<void> {
        this.clearReconnect();
        if (this.socket) {
            this.socket.end(undefined);
            this.socket = null;
        }
        this.setStatus('disconnected');
    }

    async send(message: OutboundMessage): Promise<string> {
        if (!this.socket) throw new Error('WhatsApp not connected');

        const jid = message.peer.id;

        const quoted = message.replyTo ? this.replyCache.get(message.replyTo) : undefined;
        const sendOpts: MiscMessageGenerationOptions = quoted ? { quoted } : {};

        if (message.media?.length) {
            let lastId = '';
            for (let i = 0; i < message.media.length; i++) {
                const media = message.media[i]!;
                if (!isSafeMediaUrl(media.url)) continue;
                const caption = i === 0 ? message.body : undefined;
                let content: AnyMessageContent;

                switch (media.type) {
                    case 'image':
                        content = { image: { url: media.url ?? '' }, ...(caption && { caption }) };
                        break;
                    case 'audio':
                        content = {
                            audio: { url: media.url ?? '' },
                            mimetype: media.mimeType ?? 'audio/mpeg',
                            ptt: true,
                        };
                        break;
                    case 'video':
                        content = { video: { url: media.url ?? '' }, ...(caption && { caption }) };
                        break;
                    case 'document':
                        content = {
                            document: { url: media.url ?? '' },
                            mimetype: media.mimeType ?? 'application/octet-stream',
                            fileName: media.fileName ?? 'document',
                        };
                        break;
                    default:
                        content = { text: message.body ?? '' };
                }

                const sent = await this.socket.sendMessage(
                    jid,
                    content,
                    i === 0 ? sendOpts : {},
                );
                lastId = sent?.key?.id ?? '';
            }
            return lastId;
        }

        const sent = await this.socket.sendMessage(jid, { text: message.body ?? '' }, sendOpts);
        return sent?.key?.id ?? '';
    }

    async sendTyping(peer: Peer): Promise<void> {
        if (!this.socket) return;
        if (this.channelConfig.autoTyping === false) return;
        await this.socket.presenceSubscribe(peer.id);
        await this.socket.sendPresenceUpdate('composing', peer.id);
    }

    /**
     * Delete a WhatsApp message we sent (reasoning auto-cleanup, orphan
     * preview cleanup, etc.). Baileys's "delete-for-everyone" requires a
     * full message key (remoteJid + fromMe + id + optional participant for
     * groups). We reconstruct the key from peer.id + the returned message
     * id; `fromMe: true` always — we only delete our OWN messages.
     *
     * WhatsApp's API only allows deleting your own messages within ~48h.
     * Failures are swallowed (already-gone / too-old / not-permitted).
     */
    async deleteMessage(messageId: string, peer: Peer): Promise<void> {
        if (!this.socket || !messageId) return;
        try {
            await this.socket.sendMessage(peer.id, {
                delete: {
                    remoteJid: peer.id,
                    fromMe: true,
                    id: messageId,
                },
            });
        } catch {
            /* best-effort; ignore if already gone, expired, or unsupported */
        }
    }

    /**
     * WhatsApp native: `>` blockquote (added Sept 2024) with an `_italic_`
     * body to read as "thinking aloud" vs the user-facing answer. WhatsApp
     * has no spoiler/collapsible primitive, so visual demotion via italic
     * inside a blockquote is the best native option.
     */
    override formatReasoning(content: string): string {
        const trimmed = content.trim();
        if (!trimmed) return '';
        const safe = trimmed.replace(/_/g, '\\_');
        const lines = safe.split('\n').map((l) => l ? `> _${l}_` : '>');
        return `> *💭 Reasoning*\n${lines.join('\n')}`;
    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.socket) throw new Error('WhatsApp not connected');
        await this.socket.sendMessage(options.peer.id, {
            react: {
                text: !options.emoji || options.remove ? '' : options.emoji,
                key: { id: options.messageId, remoteJid: options.peer.id },
            },
        });
    }
}
