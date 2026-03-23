import type { WASocket, ConnectionState, AnyMessageContent } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import type { Peer, OutboundMessage, ReactionOptions, Message } from '@gateway/types';
import { BaseChannel } from '@gateway/core/base-channel';
import type { WhatsAppChannelConfig } from './types';

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const MAX_RECONNECT_ATTEMPTS = 6;

export class WhatsAppChannel extends BaseChannel {
    readonly name = 'whatsapp';
    readonly authType = 'qr' as const;

    private socket: WASocket | null = null;
    private readonly channelConfig: WhatsAppChannelConfig;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private connecting = false;

    constructor(config: WhatsAppChannelConfig) {
        super(config);
        this.channelConfig = config;
    }

    async connect(): Promise<void> {
        if (this.socket || this.connecting) return;
        this.connecting = true;

        try {
            this.setStatus('connecting');

            const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason } =
                await import('@whiskeysockets/baileys');
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
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.emit('onQR', qr);
                }

                if (connection === 'open') {
                    this.reconnectAttempts = 0;
                    this.setStatus('connected');
                    this.emit('onAuthUpdate', 'authenticated');
                }

                if (connection === 'close') {
                    this.socket = null;
                    const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

                    if (statusCode === DisconnectReason.loggedOut) {
                        this.setStatus('disconnected');
                        this.emit('onAuthUpdate', 'expired');
                        return;
                    }

                    this.scheduleReconnect();
                }
            });

            this.socket.ev.on('messages.upsert', async ({ messages }) => {
                for (const msg of messages) {
                    if (!msg.message || msg.key.fromMe) continue;

                    const senderId = msg.key.remoteJid ?? '';
                    const isGroup = senderId.endsWith('@g.us');
                    const peerType = isGroup ? 'group' as const : 'user' as const;

                    if (!this.isAllowed(senderId, peerType)) continue;

                    const body =
                        msg.message.conversation ??
                        msg.message.extendedTextMessage?.text ??
                        msg.message.imageMessage?.caption ??
                        '';

                    const normalized: Message = {
                        id: msg.key.id ?? '',
                        channelName: this.name,
                        peer: { id: senderId, type: peerType },
                        sender: msg.key.participant
                            ? { id: msg.key.participant }
                            : undefined,
                        body,
                        timestamp: new Date((msg.messageTimestamp as number) * 1000).toISOString(),
                    };

                    await this.emit('onMessage', normalized);
                }
            });
        } catch (err) {
            this.setStatus('error');
            this.emitError(err instanceof Error ? err : new Error(String(err)));
        } finally {
            this.connecting = false;
        }
    }

    async clearSession(): Promise<void> {
        if (!this.channelConfig.sessionPath) return;
        const { rm } = await import('fs/promises');
        await rm(this.channelConfig.sessionPath, { recursive: true, force: true }).catch(() => {});
    }

    async disconnect(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;
        if (this.socket) {
            this.socket.end(undefined);
            this.socket = null;
        }
        this.setStatus('disconnected');
    }

    async send(message: OutboundMessage): Promise<string> {
        if (!this.socket) throw new Error('WhatsApp not connected');

        const jid = message.peer.id;

        if (message.media?.length) {
            let lastId = '';
            for (let i = 0; i < message.media.length; i++) {
                const media = message.media[i]!;
                const caption = i === 0 ? message.body : undefined;
                let content: AnyMessageContent;

                switch (media.type) {
                    case 'image':
                        content = { image: { url: media.url ?? '' }, ...(caption && { caption }) };
                        break;
                    case 'audio':
                        content = { audio: { url: media.url ?? '' }, mimetype: media.mimeType ?? 'audio/mpeg', ptt: true };
                        break;
                    case 'video':
                        content = { video: { url: media.url ?? '' }, ...(caption && { caption }) };
                        break;
                    case 'document':
                        content = { document: { url: media.url ?? '' }, mimetype: media.mimeType ?? 'application/octet-stream', fileName: media.fileName ?? 'document' };
                        break;
                    default:
                        content = { text: message.body ?? '' };
                }

                const sent = await this.socket.sendMessage(jid, content);
                lastId = sent?.key?.id ?? '';
            }
            return lastId;
        }

        const sent = await this.socket.sendMessage(jid, { text: message.body ?? '' });
        return sent?.key?.id ?? '';
    }

    async sendTyping(peer: Peer): Promise<void> {
        if (!this.socket) return;
        await this.socket.presenceSubscribe(peer.id);
        await this.socket.sendPresenceUpdate('composing', peer.id);
    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.socket) throw new Error('WhatsApp not connected');

        const text = !options.emoji || options.remove ? '' : options.emoji;
        await this.socket.sendMessage(options.peer.id, {
            react: { text, key: { id: options.messageId, remoteJid: options.peer.id } },
        });
    }

    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            this.setStatus('error');
            this.emitError(new Error('Max reconnect attempts reached'));
            return;
        }

        const delay = RECONNECT_BACKOFF_MS[this.reconnectAttempts] ?? 60_000;
        this.reconnectAttempts++;
        this.setStatus('connecting');

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch((err) => this.emitError(err instanceof Error ? err : new Error(String(err))));
        }, delay);
    }
}
