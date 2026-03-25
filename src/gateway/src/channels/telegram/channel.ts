import type { Peer, OutboundMessage, ReactionOptions, Message } from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import { isSafeMediaUrl } from '@gateway/core/security';
import type { TelegramChannelConfig } from './types';

export class TelegramChannel extends BaseChannel {
    readonly name = 'telegram';
    readonly authType = 'token';

    private bot: import('grammy').Bot | null = null;
    private botInfo: { id: number; username: string } | null = null;
    private readonly channelConfig: TelegramChannelConfig;

    constructor(config: TelegramChannelConfig) {
        super(config);
        this.channelConfig = config;
    }

    async connect(): Promise<void> {
        this.setStatus('connecting');

        try {
            const { Bot } = await import('grammy');
            this.bot = new Bot(this.channelConfig.token);

            const me = await this.bot.api.getMe();
            this.botInfo = { id: me.id, username: me.username ?? '' };

            this.bot.on('message', async (ctx) => {
                const msg = ctx.message;
                if (!msg.text && !msg.caption) return;

                const chatId = String(msg.chat.id);
                const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
                const peerType = isGroup ? 'group' as const : 'user' as const;
                const senderId = String(msg.from?.id ?? chatId);

                if (!this.isAllowed(isGroup ? chatId : senderId, peerType)) return;

                if (isGroup && this.channelConfig.groupActivation === 'mention') {
                    const text = msg.text ?? msg.caption ?? '';
                    if (!text.includes(`@${this.botInfo?.username}`)) return;
                }

                const normalized: Message = {
                    id: String(msg.message_id),
                    channelName: this.name,
                    peer: { id: chatId, type: peerType, name: msg.chat.type === 'private' ? msg.from?.first_name : msg.chat.title },
                    sender: msg.from ? { id: String(msg.from.id), name: msg.from.first_name } : undefined,
                    body: msg.text ?? msg.caption ?? '',
                    timestamp: new Date(msg.date * 1000).toISOString(),
                    replyTo: msg.reply_to_message
                        ? { id: String(msg.reply_to_message.message_id), body: (msg.reply_to_message as { text?: string }).text }
                        : undefined,
                };

                await this.emit('onMessage', normalized);
            });

            this.bot.start({ onStart: () => this.setStatus('connected') })
                .catch((err) => {
                    this.setStatus('error');
                    this.emitError(toError(err));
                });
        } catch (err) {
            this.setStatus('error');
            this.emitError(toError(err));
        }
    }

    async disconnect(): Promise<void> {
        if (this.bot) {
            await this.bot.stop();
            this.bot = null;
        }
        this.botInfo = null;
        this.setStatus('disconnected');
    }

    async send(message: OutboundMessage): Promise<string> {
        if (!this.bot) throw new Error('Telegram not connected');

        const chatId = message.peer.id;

        if (message.media?.length) {
            let lastId = 0;
            for (let i = 0; i < message.media.length; i++) {
                const media = message.media[i]!;
                const caption = i === 0 ? message.body : undefined;
                const { InputFile } = await import('grammy');
                if (!isSafeMediaUrl(media.url)) continue;
                const inputFile = new InputFile(new URL(media.url!));

                let sent;
                switch (media.type) {
                    case 'image':
                        sent = await this.bot.api.sendPhoto(chatId, inputFile, caption ? { caption } : {});
                        break;
                    case 'video':
                        sent = await this.bot.api.sendVideo(chatId, inputFile, caption ? { caption } : {});
                        break;
                    case 'audio':
                        sent = await this.bot.api.sendAudio(chatId, inputFile, caption ? { caption } : {});
                        break;
                    case 'document':
                        sent = await this.bot.api.sendDocument(chatId, inputFile, caption ? { caption } : {});
                        break;
                    default:
                        sent = await this.bot.api.sendMessage(chatId, message.body ?? '');
                }
                lastId = sent.message_id;
            }
            return String(lastId);
        }

        const body = message.body ?? '';
        if (!body.trim()) return '';

        const sent = await this.bot.api.sendMessage(chatId, body, { parse_mode: 'Markdown' })
            .catch(() => this.bot!.api.sendMessage(chatId, body));
        return String(sent.message_id);
    }

    async sendTyping(peer: Peer): Promise<void> {
        if (!this.bot) return;
        await this.bot.api.sendChatAction(peer.id, 'typing').catch(() => {});
    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.bot) throw new Error('Telegram not connected');

        const chatId = options.peer.id;
        const messageId = parseInt(options.messageId, 10);

        if (!options.emoji || options.remove) {
            await this.bot.api.setMessageReaction(chatId, messageId, []);
            return;
        }

        await this.bot.api.setMessageReaction(chatId, messageId, [
            { type: 'emoji', emoji: options.emoji as never },
        ]);
    }
}
