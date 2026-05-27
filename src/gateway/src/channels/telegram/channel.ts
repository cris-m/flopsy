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
import { isTextDocument } from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import { resolveMediaSource, type MediaSource } from '@gateway/core/media-resolver';
import { DEFAULT_PRESENCE_EMOJIS } from '@gateway/core/presence-emojis';
import { splitForTelegram } from './message-splitter';
import { markdownToTelegramHtml } from './markdown-html';
import { buildTelegramCommands } from './native-commands';
import { COMMANDS } from '@gateway/commands/registry';
import { isTelegramRateLimitError, getTelegramRetryAfterMs } from './network-errors';
import { retryTelegram } from './retry';
import type { TelegramChannelConfig } from './types';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_DOCUMENT_BYTES = 256 * 1024;

const TELEGRAM_CAPTION_MAX = 1024;

const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

function fitsCallback(s: string): boolean {
    return Buffer.byteLength(s, 'utf8') <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
}

const BOT_TOKEN_RE = /bot[0-9]+:[A-Za-z0-9_-]+/g;
function redactBotToken(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.replace(BOT_TOKEN_RE, 'bot<redacted>');
}

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
            for (let i = 0; i < block.options.length; i += ROW_SIZE) {
                const row = block.options
                    .slice(i, i + ROW_SIZE)
                    .filter((o) => fitsCallback(o.value))
                    .map((o) => ({ text: o.label, callback_data: o.value }));
                if (row.length > 0) rows.push(row);
            }
        }
    }

    return rows.length > 0 ? rows : undefined;
}

// Anything outside this set returns 400 REACTION_INVALID from Telegram.
const TELEGRAM_ALLOWED_REACTIONS: ReadonlySet<string> = new Set([
    '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢',
    '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳',
    '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐',
    '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀',
    '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅',
    '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾',
    '🤷‍♂', '🤷', '🤷‍♀', '😡',
]);

const TELEGRAM_REACTION_FALLBACKS: Readonly<Record<string, string>> = {
    [DEFAULT_PRESENCE_EMOJIS.taskRunning]: '🤔',
    [DEFAULT_PRESENCE_EMOJIS.taskOk]:      '👍',
    [DEFAULT_PRESENCE_EMOJIS.taskError]:   '👎',
    [DEFAULT_PRESENCE_EMOJIS.turnAborted]: '👎',
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
    readonly streaming: StreamingCapability;
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

    // ~1 msg/sec/chat in groups; cross-chat concurrent.
    private static readonly SEND_THROTTLE_MS = 250;
    private readonly sendChain = new Map<string | number, Promise<void>>();
    private readonly pendingThrottleTimers = new Set<ReturnType<typeof setTimeout>>();

    private async acquireChatSlot(chatId: string | number): Promise<() => void> {
        const prior = this.sendChain.get(chatId) ?? Promise.resolve();
        let release!: () => void;
        const ours = new Promise<void>((r) => { release = r; });
        this.sendChain.set(chatId, ours);
        await prior;
        return () => {
            const timer = setTimeout(() => {
                this.pendingThrottleTimers.delete(timer);
                release();
                if (this.sendChain.get(chatId) === ours) {
                    this.sendChain.delete(chatId);
                }
            }, TelegramChannel.SEND_THROTTLE_MS);
            this.pendingThrottleTimers.add(timer);
        };
    }

    constructor(config: TelegramChannelConfig) {
        super(config);
        this.channelConfig = config;
        const streamCfg = (config as TelegramChannelConfig & {
            streaming?: { enabled?: boolean; minEditIntervalMs?: number };
        }).streaming;
        this.streaming = {
            editBased: streamCfg?.enabled ?? true,
            minEditIntervalMs: streamCfg?.minEditIntervalMs ?? 1000,
        };
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
                    // Word boundary so `@news` doesn't match `@newsbot`.
                    const botUsername = this.botInfo?.username;
                    if (!botUsername) return;
                    const mentionRe = new RegExp(`@${botUsername.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
                    if (!mentionRe.test(rawText)) return;
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
                    const isText = isTextDocument(doc.mime_type, doc.file_name);
                    const withinSize = !doc.file_size || doc.file_size <= MAX_TEXT_DOCUMENT_BYTES;
                    if (isText && withinSize) {
                        const text = await this.downloadTelegramTextDocument(doc.file_id);
                        if (text !== null) {
                            media.push({
                                type: 'document',
                                fileName: doc.file_name,
                                mimeType: doc.mime_type,
                                fileSize: doc.file_size,
                                text,
                            });
                        } else {
                            media.push({ type: 'document', fileName: doc.file_name, mimeType: doc.mime_type, fileSize: doc.file_size });
                        }
                    } else {
                        media.push({ type: 'document', fileName: doc.file_name, mimeType: doc.mime_type, fileSize: doc.file_size });
                    }
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

            await this.registerNativeCommands();

            this.bot.start({ onStart: () => this.setStatus('connected') }).catch((err) => {
                this.setStatus('error');
                this.emitError(toError(err));
            });
        } catch (err) {
            this.setStatus('error');
            this.emitError(toError(err));
        }
    }

    private async registerNativeCommands(): Promise<void> {
        if (!this.bot) return;
        try {
            const commands = buildTelegramCommands(COMMANDS);
            if (commands.length === 0) return;
            await this.bot.api.setMyCommands(commands);
            this.log.info({ count: commands.length }, 'telegram: native command menu registered');
        } catch (err) {
            this.log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'telegram: setMyCommands failed (menu unavailable, commands still work)',
            );
        }
    }

    private async downloadTelegramFile(fileId: string): Promise<{ data: string; mimeType: string } | null> {
        if (!this.bot) return null;
        // URL embeds bot token — sanitize errors via redactBotToken() before logging.
        let file: Awaited<ReturnType<typeof this.bot.api.getFile>> | null = null;
        try {
            file = await this.bot.api.getFile(fileId);
        } catch (err) {
            this.log.warn(
                { fileId, err: redactBotToken(err), op: 'download:getFile' },
                'telegram getFile failed — media will be sent as placeholder',
            );
            return null;
        }
        if (!file?.file_path) {
            this.log.warn(
                { fileId, op: 'download:no-file-path' },
                'telegram getFile returned no file_path — media will be sent as placeholder',
            );
            return null;
        }
        // DO NOT LOG `url` — it embeds the bot token in the path.
        const url = `https://api.telegram.org/file/bot${this.channelConfig.token}/${file.file_path}`;
        try {
            const res = await fetch(url, { redirect: 'error' });
            if (!res.ok) {
                this.log.warn(
                    { fileId, status: res.status, op: 'download:http-error' },
                    'telegram file download HTTP error — media will be sent as placeholder',
                );
                return null;
            }
            const buffer = await res.arrayBuffer();
            if (buffer.byteLength > MAX_IMAGE_BYTES) {
                this.log.warn(
                    { fileId, bytes: buffer.byteLength, cap: MAX_IMAGE_BYTES, op: 'download:oversize' },
                    'telegram file exceeded MAX_IMAGE_BYTES — media will be sent as placeholder',
                );
                return null;
            }
            const ext = file.file_path.split('.').pop()?.toLowerCase() ?? '';
            const mimeType = ext === 'png' ? 'image/png'
                : ext === 'webp' ? 'image/webp'
                : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                : null;
            if (!mimeType) {
                this.log.warn(
                    { fileId, ext, op: 'download:unsupported-type' },
                    'telegram file extension not in allowlist — media will be sent as placeholder',
                );
                return null;
            }
            return { data: Buffer.from(buffer).toString('base64'), mimeType };
        } catch (err) {
            this.log.warn(
                { fileId, err: redactBotToken(err), op: 'download:fetch' },
                'telegram file download threw — media will be sent as placeholder',
            );
            return null;
        }
    }

    private async downloadTelegramTextDocument(fileId: string): Promise<string | null> {
        if (!this.bot) return null;
        let file: Awaited<ReturnType<typeof this.bot.api.getFile>> | null = null;
        try {
            file = await this.bot.api.getFile(fileId);
        } catch (err) {
            this.log.warn(
                { fileId, err: redactBotToken(err), op: 'doc-download:getFile' },
                'telegram doc getFile failed',
            );
            return null;
        }
        if (!file?.file_path) return null;
        const url = `https://api.telegram.org/file/bot${this.channelConfig.token}/${file.file_path}`;
        try {
            const res = await fetch(url, { redirect: 'error' });
            if (!res.ok) return null;
            const buffer = await res.arrayBuffer();
            if (buffer.byteLength > MAX_TEXT_DOCUMENT_BYTES) {
                this.log.warn(
                    { fileId, bytes: buffer.byteLength, cap: MAX_TEXT_DOCUMENT_BYTES, op: 'doc-download:oversize' },
                    'telegram text document exceeded cap — agent will get metadata only',
                );
                return null;
            }
            return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
        } catch (err) {
            this.log.warn(
                { fileId, err: redactBotToken(err), op: 'doc-download:fetch' },
                'telegram doc fetch threw',
            );
            return null;
        }
    }

    async disconnect(): Promise<void> {
        if (this.bot) {
            await this.bot.stop();
            this.bot = null;
        }
        this.botInfo = null;
        for (const timer of this.pendingThrottleTimers) clearTimeout(timer);
        this.pendingThrottleTimers.clear();
        this.sendChain.clear();
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

        const bodyLen = (message.body ?? '').length;
        const captionTooLong = bodyLen > TELEGRAM_CAPTION_MAX;

        if (message.media?.length) {
            let lastId = 0;
            for (let i = 0; i < message.media.length; i++) {
                const media = message.media[i]!;
                const caption = i === 0 && !captionTooLong ? message.body : undefined;
                const { InputFile } = await import('grammy');

                const resolved = await resolveMediaSource(media);
                if (!resolved.ok) {
                    this.log.warn(
                        { chatId, mediaType: media.type, mediaUrl: media.url, reason: resolved.reason, detail: resolved.detail, op: 'send:media:rejected' },
                        'telegram send: media resolution failed — skipping attachment',
                    );
                    continue;
                }
                const inputFile = mediaSourceToInputFile(resolved.source, InputFile);

                const release = await this.acquireChatSlot(chatId);
                let sent;
                try {
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
                } finally {
                    release();
                }
                lastId = sent.message_id;
            }
            if (!captionTooLong) return String(lastId);
        }

        const body = message.body ?? '';
        if (!body.trim()) return '';

        const keyboard = message.interactive
            ? buildInlineKeyboard(message.interactive)
            : undefined;
        const replyMarkup = keyboard ? { inline_keyboard: keyboard } : undefined;

        const replyParameters =
            message.replyTo && /^\d+$/.test(message.replyTo)
                ? { reply_parameters: { message_id: parseInt(message.replyTo, 10) } }
                : undefined;

        const chunks = splitForTelegram(body);
        let lastId = '';
        for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            const chunkBody = chunks[i]!;
            const release = await this.acquireChatSlot(chatId);
            try {
            // 429: same-variant retry with retry_after. 400 format errors fall through HTML → plain.
            const htmlBody = markdownToTelegramHtml(chunkBody);
            const trySendWith = (parseMode?: 'HTML') =>
                retryTelegram(
                    () => this.bot!.api.sendMessage(chatId, parseMode ? htmlBody : chunkBody, {
                        ...(parseMode ? { parse_mode: parseMode } : {}),
                        ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
                        ...(i === 0 ? (replyParameters ?? {}) : {}),
                    }),
                    {
                        shouldRetry: isTelegramRateLimitError,
                        retryAfterMs: getTelegramRetryAfterMs,
                        onRetry: ({ attempt, delayMs, err }) => {
                            this.log.warn(
                                {
                                    chatId,
                                    attempt,
                                    delayMs,
                                    parseMode: parseMode ?? 'plain',
                                    op: 'send:rate-limit-retry',
                                    err: err instanceof Error ? err.message : String(err),
                                },
                                'telegram send: 429 backoff',
                            );
                        },
                    },
                );

            const sent = await trySendWith('HTML').catch((htmlErr: unknown) => {
                if (isTelegramRateLimitError(htmlErr)) throw htmlErr;
                this.log.warn(
                    { chatId, err: htmlErr instanceof Error ? htmlErr.message : String(htmlErr), chunk: i, chunks: chunks.length, op: 'send:retry-plain' },
                    'telegram send: HTML failed (format), retrying plain',
                );
                return trySendWith(undefined);
            }).catch((finalErr: unknown) => {
                this.log.error(
                    {
                        chatId,
                        err: finalErr instanceof Error ? finalErr.message : String(finalErr),
                        is429: isTelegramRateLimitError(finalErr),
                        chunk: i,
                        chunks: chunks.length,
                    },
                    'telegram send: all paths exhausted — message dropped',
                );
                throw finalErr;
            });
            lastId = String(sent.message_id);
            } finally {
                release();
            }
        }
        this.log.debug({ chatId, messageId: lastId, chunks: chunks.length }, 'telegram send: ok');
        return lastId;
    }

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
            // Telegram open_period range is 5-600 seconds.
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
        await this.bot.api.sendChatAction(peer.id, 'typing').catch(() => {});
    }

    /**
     * Telegram-native collapsible reasoning: MarkdownV2 expandable blockquote
     * (Bot API 7.0+, Jan 2024). Syntax: `**>` opens, `>` continues each line,
     * `||` at end marks the block as expandable (collapsed by default with a
     * "Show more" link). First line is a header so the collapsed bubble shows
     * "💭 Reasoning…" before the user taps.
     */
    override formatReasoning(content: string): string {
        const trimmed = content.trimEnd();
        if (!trimmed) return '';
        const escape = (s: string) => s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
        const lines = ['💭 Reasoning', ...trimmed.split('\n')].map(escape);
        return lines.map((l, i) => (i === 0 ? '**>' : '>') + l).join('\n') + '||';
    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.bot) throw new Error('Telegram not connected');

        if (!options.messageId) return;
        const chatId = options.peer.id;
        const messageId = parseInt(options.messageId, 10);
        if (!Number.isFinite(messageId)) return;

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
        // Telegram caps editMessageText at 4096; long final replies route through send() instead,
        // so a truncation marker here reliably means "more is streaming", not data loss.
        const TELEGRAM_EDIT_CAP = 4000;
        const truncated = body.length > TELEGRAM_EDIT_CAP
            ? body.slice(0, TELEGRAM_EDIT_CAP) + '\n\n_…streaming…_'
            : body;
        const msgId = parseInt(messageId, 10);

        const tryEditWith = (parseMode?: 'MarkdownV2' | 'Markdown') =>
            retryTelegram(
                () => this.bot!.api.editMessageText(peer.id, msgId, truncated, {
                    ...(parseMode ? { parse_mode: parseMode } : {}),
                }),
                {
                    shouldRetry: isTelegramRateLimitError,
                    retryAfterMs: getTelegramRetryAfterMs,
                    attempts: 2,
                },
            );

        await tryEditWith('MarkdownV2').catch((v2Err: unknown) => {
            if (isTelegramRateLimitError(v2Err)) throw v2Err;
            return tryEditWith('Markdown').catch((legacyErr: unknown) => {
                if (isTelegramRateLimitError(legacyErr)) throw legacyErr;
                return tryEditWith(undefined);
            });
        });
    }

    async deleteMessage(messageId: string, peer: Peer): Promise<void> {
        if (!this.bot) return;
        const id = parseInt(messageId, 10);
        if (!Number.isFinite(id)) return;
        await this.bot.api.deleteMessage(peer.id, id).catch(() => {});
    }
}

function mediaSourceToInputFile(
    source: MediaSource,
    InputFileCtor: typeof import('grammy').InputFile,
): import('grammy').InputFile {
    switch (source.kind) {
        case 'remote-url':
            return new InputFileCtor(source.url);
        case 'local-path':
            return new InputFileCtor(source.absPath, source.fileName);
        case 'buffer':
            return new InputFileCtor(source.data, source.fileName);
    }
}
