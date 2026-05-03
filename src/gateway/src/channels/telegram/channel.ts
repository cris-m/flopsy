import type {
    Peer,
    OutboundMessage,
    ReactionOptions,
    Message,
    Media,
    StreamingCapability,
    InteractiveReply,
    InteractionCallback,
    InteractiveCapability,
} from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import { isSafeMediaUrl } from '@gateway/core/security';
import { splitForTelegram } from './message-splitter';
import type { TelegramChannelConfig } from './types';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Telegram callback_data is a 1-64 byte opaque string returned on tap.
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

function fitsCallback(s: string): boolean {
    return Buffer.byteLength(s, 'utf8') <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
}

/** Build Telegram's inline_keyboard shape from our InteractiveReply. */
function buildInlineKeyboard(
    interactive: InteractiveReply,
): Array<Array<{ text: string; callback_data: string }>> | undefined {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    const ROW_SIZE = 3;

    for (const block of interactive.blocks) {
        if (block.type === 'buttons') {
            for (let i = 0; i < block.buttons.length; i += ROW_SIZE) {
                const row = block.buttons
                    .slice(i, i + ROW_SIZE)
                    .filter((b) => fitsCallback(b.value))
                    .map((b) => ({ text: b.label, callback_data: b.value }));
                if (row.length > 0) rows.push(row);
            }
        } else if (block.type === 'select') {
            // Telegram has no native dropdown — render as buttons.
            for (let i = 0; i < block.options.length; i += ROW_SIZE) {
                const row = block.options
                    .slice(i, i + ROW_SIZE)
                    .filter((o) => fitsCallback(o.value))
                    .map((o) => ({ text: o.label, callback_data: o.value }));
                if (row.length > 0) rows.push(row);
            }
        }
        // `poll` blocks handled via sendPoll.
    }

    return rows.length > 0 ? rows : undefined;
}

// Telegram Bot API reaction whitelist. Anything outside returns 400
// REACTION_INVALID. https://core.telegram.org/bots/api#reactiontypeemoji
const TELEGRAM_ALLOWED_REACTIONS: ReadonlySet<string> = new Set([
    '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢',
    '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳',
    '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐',
    '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀',
    '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅',
    '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾',
    '🤷‍♂', '🤷', '🤷‍♀', '😡',
]);

// Approximate-match table for agent-emitted emojis outside Telegram's
// whitelist. Unknown input falls through to 👍.
const TELEGRAM_REACTION_FALLBACKS: Readonly<Record<string, string>> = {
    '⏳': '🤔', // in-progress / thinking
    '✅': '👍', // done / success
    '❌': '👎', // fail / reject
    '⚙': '🤔',
    '⚙️': '🤔',
    '📝': '✍',
    '💡': '🤔',
    '🚀': '🔥',
    '🔧': '🤔',
    '📦': '🤔',
    '⭐': '🔥',
    '☑': '👍',
    '✔': '👍',
    '✔️': '👍',
    'ℹ': '🤔',
    'ℹ️': '🤔',
    '⚠': '🤔',
    '⚠️': '🤔',
    '🛑': '👎',
    '⛔': '👎',
    '🤖': '👨‍💻',
    '💻': '👨‍💻',
};

function mapToTelegramAllowedEmoji(input: string): string {
    if (TELEGRAM_ALLOWED_REACTIONS.has(input)) return input;
    const mapped = TELEGRAM_REACTION_FALLBACKS[input];
    if (mapped && TELEGRAM_ALLOWED_REACTIONS.has(mapped)) return mapped;
    return '👍';
}

export class TelegramChannel extends BaseChannel {
    readonly name = 'telegram';
    readonly authType = 'token';
    readonly streaming: StreamingCapability = { editBased: true, minEditIntervalMs: 1000 };
    readonly capabilities: readonly InteractiveCapability[] = [
        'buttons',
        'polls',
        'reactions',
        'typing',
        'edit-message',
    ];

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

                const hasContent =
                    msg.text || msg.caption || msg.photo?.length ||
                    msg.document || msg.video || msg.sticker ||
                    msg.location || msg.venue;
                if (!hasContent) return;

                const chatId = String(msg.chat.id);
                const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
                const peerType = isGroup ? ('group' as const) : ('user' as const);
                const senderId = String(msg.from?.id ?? chatId);

                if (!this.isAllowed(isGroup ? chatId : senderId, peerType)) return;

                const rawText = msg.text ?? msg.caption ?? '';
                if (isGroup && this.channelConfig.groupActivation === 'mention') {
                    if (!rawText.includes(`@${this.botInfo?.username}`)) return;
                }

                const media: Media[] = [];
                let body = rawText;
                let synthetic = false;

                if (msg.venue) {
                    const loc = msg.venue.location;
                    body = `[Location: "${msg.venue.title}", ${msg.venue.address} (lat=${loc.latitude}, lon=${loc.longitude})]${body ? ' ' + body : ''}`;
                } else if (msg.location) {
                    const loc = msg.location;
                    const acc = (loc as { horizontal_accuracy?: number }).horizontal_accuracy;
                    body = `[Location: lat=${loc.latitude}, lon=${loc.longitude}${acc ? `, accuracy=${acc}m` : ''}]${body ? ' ' + body : ''}`;
                }

                if (msg.photo?.length) {
                    const largest = msg.photo[msg.photo.length - 1]!;
                    if (!largest.file_size || largest.file_size <= MAX_IMAGE_BYTES) {
                        const dl = await this.downloadTelegramFile(largest.file_id);
                        if (dl) {
                            media.push({ type: 'image', data: dl.data, mimeType: dl.mimeType });
                        } else {
                            media.push({ type: 'image' });
                        }
                    } else {
                        media.push({ type: 'image' });
                    }
                    if (!body) { body = '[Image]'; synthetic = true; }
                }

                if (msg.document) {
                    const doc = msg.document as { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
                    media.push({ type: 'document', fileName: doc.file_name, mimeType: doc.mime_type, fileSize: doc.file_size });
                    if (!body) { body = `[Document: ${doc.file_name ?? doc.mime_type ?? 'file'}]`; synthetic = true; }
                }

                if (msg.video) {
                    const vid = msg.video as { mime_type?: string; file_size?: number };
                    media.push({ type: 'video', mimeType: vid.mime_type, fileSize: vid.file_size });
                    if (!body) { body = '[Video]'; synthetic = true; }
                }

                if (msg.sticker) {
                    const stk = msg.sticker as { emoji?: string };
                    media.push({ type: 'sticker' });
                    if (!body) { body = `[Sticker${stk.emoji ? ': ' + stk.emoji : ''}]`; synthetic = true; }
                }

                const normalized: Message = {
                    id: String(msg.message_id),
                    channelName: this.name,
                    peer: {
                        id: chatId,
                        type: peerType,
                        name: msg.chat.type === 'private' ? msg.from?.first_name : msg.chat.title,
                    },
                    sender: msg.from
                        ? { id: String(msg.from.id), name: msg.from.first_name }
                        : undefined,
                    body,
                    synthetic: synthetic || undefined,
                    timestamp: new Date(msg.date * 1000).toISOString(),
                    replyTo: msg.reply_to_message
                        ? {
                              id: String(msg.reply_to_message.message_id),
                              body: (msg.reply_to_message as { text?: string }).text,
                          }
                        : undefined,
                    media: media.length > 0 ? media : undefined,
                };

                await this.emit('onMessage', normalized);
            });

            this.bot.on('callback_query:data', async (ctx) => {
                const q = ctx.callbackQuery;
                const data = q.data;
                const msg = q.message;
                if (!data || !msg) {
                    await ctx.answerCallbackQuery().catch(() => {});
                    return;
                }

                const chat = msg.chat;
                const isGroup = chat.type === 'group' || chat.type === 'supergroup';
                const peer: Peer = {
                    id: String(chat.id),
                    type: isGroup ? 'group' : 'user',
                    name:
                        chat.type === 'private'
                            ? q.from.first_name
                            : (chat as { title?: string }).title,
                };

                // Empty acknowledgement — dismisses the client's loading spinner.
                await ctx.answerCallbackQuery().catch(() => {});

                const callback: InteractionCallback = {
                    type: 'button_click',
                    value: data,
                    messageId: String(msg.message_id),
                    peer,
                    sender: { id: String(q.from.id), name: q.from.first_name },
                };
                await this.emit('onInteraction', callback);
            });

            this.bot.start({ onStart: () => this.setStatus('connected') }).catch((err) => {
                this.setStatus('error');
                this.emitError(toError(err));
            });
        } catch (err) {
            this.setStatus('error');
            this.emitError(toError(err));
        }
    }

    private async downloadTelegramFile(fileId: string): Promise<{ data: string; mimeType: string } | null> {
        if (!this.bot) return null;
        try {
            const file = await this.bot.api.getFile(fileId);
            if (!file.file_path) return null;
            const url = `https://api.telegram.org/file/bot${this.channelConfig.token}/${file.file_path}`;
            const res = await fetch(url);
            if (!res.ok) return null;
            const buffer = await res.arrayBuffer();
            if (buffer.byteLength > MAX_IMAGE_BYTES) return null;
            const ext = file.file_path.split('.').pop()?.toLowerCase() ?? 'jpg';
            const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
            return { data: Buffer.from(buffer).toString('base64'), mimeType };
        } catch {
            return null;
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

        const _bodyPreview = (message.body ?? '').slice(0, 80);
        this.log.debug(
            { chatId, bodyLen: (message.body ?? '').length, preview: _bodyPreview, hasMedia: !!message.media?.length },
            'telegram send: attempting',
        );

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
                        sent = await this.bot.api.sendPhoto(
                            chatId,
                            inputFile,
                            caption ? { caption } : {},
                        );
                        break;
                    case 'video':
                        sent = await this.bot.api.sendVideo(
                            chatId,
                            inputFile,
                            caption ? { caption } : {},
                        );
                        break;
                    case 'audio':
                        sent = await this.bot.api.sendAudio(
                            chatId,
                            inputFile,
                            caption ? { caption } : {},
                        );
                        break;
                    case 'document':
                        sent = await this.bot.api.sendDocument(
                            chatId,
                            inputFile,
                            caption ? { caption } : {},
                        );
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

        const keyboard = message.interactive
            ? buildInlineKeyboard(message.interactive)
            : undefined;
        const replyMarkup = keyboard ? { inline_keyboard: keyboard } : undefined;

        // Bad replyTo (gone / wrong chat / non-integer) makes sendMessage 400 —
        // the catch below retries without it.
        const replyParameters =
            message.replyTo && /^\d+$/.test(message.replyTo)
                ? { reply_parameters: { message_id: parseInt(message.replyTo, 10) } }
                : undefined;

        // Splitter is fence-aware. Reply markup + quote-reply attach to the
        // last chunk so taps land on the most recent message.
        const chunks = splitForTelegram(body);
        let lastId = '';
        for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            const chunkBody = chunks[i]!;
            const sent = await this.bot.api
                .sendMessage(chatId, chunkBody, {
                    parse_mode: 'Markdown',
                    ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
                    ...(i === 0 ? (replyParameters ?? {}) : {}),
                })
                .catch((mdErr: unknown) => {
                    // Markdown parse failure → retry as plain text.
                    this.log.warn(
                        {
                            chatId,
                            err: mdErr instanceof Error ? mdErr.message : String(mdErr),
                            chunk: i,
                            chunks: chunks.length,
                        },
                        'telegram send: markdown send failed, retrying plain',
                    );
                    return this.bot!.api.sendMessage(chatId, chunkBody, {
                        ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
                    });
                })
                .catch((plainErr: unknown) => {
                    // Plain-text retry failed (403 bot blocked / 400 chat
                    // not found / 429 rate limit).
                    this.log.error(
                        {
                            chatId,
                            err: plainErr instanceof Error ? plainErr.message : String(plainErr),
                            chunk: i,
                            chunks: chunks.length,
                        },
                        'telegram send: BOTH markdown AND plain-text sends failed — message dropped',
                    );
                    throw plainErr;
                });
            lastId = String(sent.message_id);
        }
        this.log.debug({ chatId, messageId: lastId, chunks: chunks.length }, 'telegram send: ok');
        return lastId;
    }

    /**
     * Native Telegram poll. Telegram caps:
     *   - question ≤ 300 chars, 2-10 options each ≤ 100 chars
     *   - open_period in SECONDS, range 5-600
     */
    async sendPoll(args: {
        peer: Peer;
        question: string;
        options: readonly string[];
        anonymous?: boolean;
        allowMultiple?: boolean;
        durationHours?: number;
    }): Promise<string> {
        if (!this.bot) throw new Error('Telegram not connected');
        const chatId = args.peer.id;
        const pollOpts: Record<string, unknown> = {
            is_anonymous: args.anonymous ?? false,
            allows_multiple_answers: args.allowMultiple ?? false,
        };
        if (args.durationHours !== undefined) {
            // Clamp to Telegram's 5-600 second open_period range.
            const seconds = Math.min(600, Math.max(5, Math.round(args.durationHours * 3600)));
            pollOpts.open_period = seconds;
        }
        const sent = await this.bot.api.sendPoll(
            chatId,
            args.question,
            args.options.map((o) => ({ text: o })),
            pollOpts,
        );
        return String(sent.message_id);
    }

    async sendTyping(peer: Peer): Promise<void> {
        if (!this.bot) return;
        await this.bot.api.sendChatAction(peer.id, 'typing').catch(() => { /* fire-and-forget */ });
    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.bot) throw new Error('Telegram not connected');

        const chatId = options.peer.id;
        const messageId = parseInt(options.messageId, 10);

        if (!options.emoji || options.remove) {
            await this.bot.api.setMessageReaction(chatId, messageId, []);
            return;
        }

        const emoji = mapToTelegramAllowedEmoji(options.emoji);
        await this.bot.api.setMessageReaction(chatId, messageId, [
            { type: 'emoji', emoji: emoji as never },
        ]);
    }

    async editMessage(messageId: string, peer: Peer, body: string): Promise<void> {
        if (!this.bot) throw new Error('Telegram not connected');
        // Telegram caps editMessageText at 4096; truncate the streaming
        // preview. The final reply goes through `send` which chunks.
        const TELEGRAM_EDIT_CAP = 4000;
        const truncated = body.length > TELEGRAM_EDIT_CAP
            ? body.slice(0, TELEGRAM_EDIT_CAP) + '\n\n_… (truncated preview; full reply incoming)_'
            : body;
        await this.bot.api
            .editMessageText(peer.id, parseInt(messageId, 10), truncated, { parse_mode: 'Markdown' })
            .catch(() => this.bot!.api.editMessageText(peer.id, parseInt(messageId, 10), truncated));
    }
}
