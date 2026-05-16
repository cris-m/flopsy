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
import { resolveMediaSource, type MediaSource } from '@gateway/core/media-resolver';
import { DEFAULT_PRESENCE_EMOJIS } from '@gateway/core/presence-emojis';
import { splitForTelegram } from './message-splitter';
import { isTelegramRateLimitError, getTelegramRetryAfterMs } from './network-errors';
import { retryTelegram } from './retry';
import type { TelegramChannelConfig } from './types';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Telegram caption cap; over-limit bodies are sent as a separate chunked text message. */
const TELEGRAM_CAPTION_MAX = 1024;

// Telegram callback_data is a 1-64 byte opaque string returned on tap.
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

function fitsCallback(s: string): boolean {
    return Buffer.byteLength(s, 'utf8') <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
}

/** Strip bot tokens from log strings. Telegram tokens appear in file-download URLs. */
const BOT_TOKEN_RE = /bot[0-9]+:[A-Za-z0-9_-]+/g;
function redactBotToken(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw.replace(BOT_TOKEN_RE, 'bot<redacted>');
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
    /** Streaming-preview toggle; driven by channels.telegram.streaming config. */
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

    // Per-chat outbound throttle (~1 msg/sec/chat in groups; cross-chat concurrent).
    private static readonly SEND_THROTTLE_MS = 250;
    private readonly sendChain = new Map<string | number, Promise<void>>();
    /** Pending throttle-release timers; cleared by disconnect() to free the event loop. */
    private readonly pendingThrottleTimers = new Set<ReturnType<typeof setTimeout>>();

    /** Serialize sends per-chat with a 250ms gap; caller must invoke release in finally. */
    private async acquireChatSlot(chatId: string | number): Promise<() => void> {
        const prior = this.sendChain.get(chatId) ?? Promise.resolve();
        let release!: () => void;
        const ours = new Promise<void>((r) => { release = r; });
        this.sendChain.set(chatId, ours);
        await prior;
        return () => {
            // Defer release so the next send waits the full throttle window.
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
        // Per-channel streaming toggle; defaults from schema.
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
                    // Word-boundary match so `@news` doesn't match `@newsbot`.
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
        // URL contains bot token — never log it; sanitize errors via redactBotToken().
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

    async disconnect(): Promise<void> {
        if (this.bot) {
            await this.bot.stop();
            this.bot = null;
        }
        this.botInfo = null;
        // Clear throttle timers so the event loop can exit cleanly.
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
                // Drop caption when body exceeds Telegram's caption cap — body sent as text.
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

                // Throttle each media send so multi-attachment doesn't burst N API calls.
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
            // Caption fits → media-only send complete; otherwise body sent as text follow-up.
            if (!captionTooLong) return String(lastId);
        }

        const body = message.body ?? '';
        if (!body.trim()) return '';

        const keyboard = message.interactive
            ? buildInlineKeyboard(message.interactive)
            : undefined;
        const replyMarkup = keyboard ? { inline_keyboard: keyboard } : undefined;

        // Bad replyTo 400s sendMessage; catch retries without it.
        const replyParameters =
            message.replyTo && /^\d+$/.test(message.replyTo)
                ? { reply_parameters: { message_id: parseInt(message.replyTo, 10) } }
                : undefined;

        // Fence-aware splitter; reply markup + quote-reply attach to the last chunk.
        const chunks = splitForTelegram(body);
        let lastId = '';
        for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            const chunkBody = chunks[i]!;
            // Per-chunk throttle; chunks share the chat rate bucket.
            const release = await this.acquireChatSlot(chatId);
            try {
            // 429: same-variant retry with retry_after. 400 markdown errors: V2 → legacy → plain.
            const trySendWith = (parseMode?: 'MarkdownV2' | 'Markdown') =>
                retryTelegram(
                    () => this.bot!.api.sendMessage(chatId, chunkBody, {
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

            const sent = await trySendWith('MarkdownV2').catch((v2Err: unknown) => {
                if (isTelegramRateLimitError(v2Err)) throw v2Err; // already retried inside
                this.log.debug(
                    { chatId, err: v2Err instanceof Error ? v2Err.message : String(v2Err), chunk: i, op: 'send:retry-legacy-markdown' },
                    'telegram send: MarkdownV2 failed (format), retrying legacy Markdown',
                );
                return trySendWith('Markdown').catch((legacyErr: unknown) => {
                    if (isTelegramRateLimitError(legacyErr)) throw legacyErr;
                    this.log.warn(
                        { chatId, err: legacyErr instanceof Error ? legacyErr.message : String(legacyErr), chunk: i, chunks: chunks.length },
                        'telegram send: both markdown dialects failed (format), retrying plain',
                    );
                    return trySendWith(undefined);
                });
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

        // Synthetic / queued messages have empty ids; skip rather than 400.
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
        // Telegram caps editMessageText at 4096; truncate streaming preview.
        const TELEGRAM_EDIT_CAP = 4000;
        const truncated = body.length > TELEGRAM_EDIT_CAP
            ? body.slice(0, TELEGRAM_EDIT_CAP) + '\n\n_… (truncated preview; full reply incoming)_'
            : body;
        const msgId = parseInt(messageId, 10);

        // Same split as `send`: 429 → wait retry_after; format error → next variant.
        const tryEditWith = (parseMode?: 'MarkdownV2' | 'Markdown') =>
            retryTelegram(
                () => this.bot!.api.editMessageText(peer.id, msgId, truncated, {
                    ...(parseMode ? { parse_mode: parseMode } : {}),
                }),
                {
                    shouldRetry: isTelegramRateLimitError,
                    retryAfterMs: getTelegramRetryAfterMs,
                    // Streaming edits bounded — worker's circuit breaker handles further protection.
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

    /** Best-effort delete for orphan stream previews; errors are swallowed. */
    async deleteMessage(messageId: string, peer: Peer): Promise<void> {
        if (!this.bot) return;
        const id = parseInt(messageId, 10);
        if (!Number.isFinite(id)) return;
        await this.bot.api.deleteMessage(peer.id, id).catch(() => {
            /* swallow — best-effort cleanup */
        });
    }
}

/** Convert resolver's MediaSource into grammy's InputFile (lazy-imported). */
function mediaSourceToInputFile(
    source: MediaSource,
    InputFileCtor: typeof import('grammy').InputFile,
): import('grammy').InputFile {
    switch (source.kind) {
        case 'remote-url':
            return new InputFileCtor(source.url);
        case 'local-path':
            // Grammy streams the file at send time — no in-memory buffer.
            return new InputFileCtor(source.absPath, source.fileName);
        case 'buffer':
            return new InputFileCtor(source.data, source.fileName);
    }
}
