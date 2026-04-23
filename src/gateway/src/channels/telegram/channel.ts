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
import type { TelegramChannelConfig } from './types';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Telegram's callback_data is a 1-64 byte opaque string returned verbatim
// when the user taps an inline-keyboard button. We put the button's `value`
// here — for plan approval that's "go" / "edit" / "no", which happens to
// match the regex classifier's vocabulary so taps synthesize cleanly.
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
            // Chunk into rows of up to 3 to avoid overflow on narrow clients.
            for (let i = 0; i < block.buttons.length; i += ROW_SIZE) {
                const row = block.buttons
                    .slice(i, i + ROW_SIZE)
                    .filter((b) => fitsCallback(b.value))
                    .map((b) => ({ text: b.label, callback_data: b.value }));
                if (row.length > 0) rows.push(row);
            }
        } else if (block.type === 'select') {
            // Render select options as buttons (Telegram has no native
            // dropdown). Select values that exceed 64 bytes are dropped.
            for (let i = 0; i < block.options.length; i += ROW_SIZE) {
                const row = block.options
                    .slice(i, i + ROW_SIZE)
                    .filter((o) => fitsCallback(o.value))
                    .map((o) => ({ text: o.label, callback_data: o.value }));
                if (row.length > 0) rows.push(row);
            }
        }
        // `poll` blocks handled via sendPoll (separate code path).
    }

    return rows.length > 0 ? rows : undefined;
}

/**
 * Telegram's fixed reaction whitelist (from Bot API docs). Any emoji outside
 * this set returns 400 `REACTION_INVALID`. Kept as a Set for O(1) membership
 * checks before calling `setMessageReaction`.
 */
const TELEGRAM_ALLOWED_REACTIONS: ReadonlySet<string> = new Set([
    '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢',
    '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳',
    '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐',
    '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀',
    '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅',
    '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾',
    '🤷‍♂', '🤷', '🤷‍♀', '😡',
]);

/**
 * Approximate-match table for emojis the agent commonly emits that aren't in
 * Telegram's whitelist. Keyed by the agent's choice → the nearest allowed
 * emoji with similar semantic meaning. Unknown input falls through to 👍
 * (neutral acknowledgement) — better than a 400 error, silent to the user.
 */
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
    // Interactive surfaces Telegram renders natively. The agent reads this via
    // the runtime block in its system prompt, so tool-routing decisions
    // (ask_user, send_poll, send_message+buttons) are driven by what's
    // actually available on the current channel instead of hard-coded names.
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

            // Inline-keyboard button taps arrive as callback_query updates.
            // We answer() immediately (dismisses the client's "loading"
            // spinner + shows an optional toast), then emit onInteraction so
            // the ChannelWorker can synthesize a user message from the
            // button's callback_data. This lets the existing text-classifier
            // handle approve/edit/reject without knowing about buttons.
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

                // Cheap acknowledgement — empty text is fine; using the
                // button's label would duplicate the text the user already
                // sees tapped.
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

        // Interactive attachments — inline keyboard when the caller
        // specified `buttons` / `select` blocks. `poll` blocks go through
        // a different path (sendPoll). Drops silently if nothing fits
        // Telegram's 64-byte callback_data cap.
        const keyboard = message.interactive
            ? buildInlineKeyboard(message.interactive)
            : undefined;
        const replyMarkup = keyboard ? { inline_keyboard: keyboard } : undefined;

        const sent = await this.bot.api
            .sendMessage(chatId, body, {
                parse_mode: 'Markdown',
                ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            })
            .catch(() =>
                this.bot!.api.sendMessage(chatId, body, {
                    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                }),
            );
        return String(sent.message_id);
    }

    /**
     * Native Telegram poll. Limits per Telegram API:
     *   - question ≤ 300 chars, 2-10 options each ≤ 100 chars
     *   - open_period (auto-close) is in SECONDS, range 5-600 (max 10 min)
     *   - is_anonymous default true; we pass it through explicitly so the
     *     agent can opt in to non-anonymous when it wants vote signals.
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
            // Telegram caps open_period at 600 seconds (10 minutes). Clamp
            // to keep the call from failing on long durations the Discord
            // API would accept.
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
        // Typing indicators are fire-and-forget cosmetics — throttled by
        // Telegram, fail benignly under rate limits or transient network
        // blips. Deliberately silent to avoid log spam; a real connectivity
        // issue surfaces elsewhere (sendMessage failures will log).
        await this.bot.api.sendChatAction(peer.id, 'typing').catch(() => { /* intentionally silent */ });
    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.bot) throw new Error('Telegram not connected');

        const chatId = options.peer.id;
        const messageId = parseInt(options.messageId, 10);

        if (!options.emoji || options.remove) {
            await this.bot.api.setMessageReaction(chatId, messageId, []);
            return;
        }

        // Telegram only accepts reactions from a FIXED whitelist of emojis
        // (see https://core.telegram.org/bots/api#reactiontypeemoji). Sending
        // anything outside the set returns 400 `REACTION_INVALID`. Map common
        // agent-emitted emojis (⏳, ✅, ❌, ⚙️, 📝, etc.) to close analogues in
        // the whitelist; fall back to 👍 for anything else. Prevents log spam
        // when the LLM picks a reasonable emoji that Telegram doesn't support.
        const emoji = mapToTelegramAllowedEmoji(options.emoji);
        await this.bot.api.setMessageReaction(chatId, messageId, [
            { type: 'emoji', emoji: emoji as never },
        ]);
    }

    async editMessage(messageId: string, peer: Peer, body: string): Promise<void> {
        if (!this.bot) throw new Error('Telegram not connected');
        await this.bot.api
            .editMessageText(peer.id, parseInt(messageId, 10), body, { parse_mode: 'Markdown' })
            .catch(() => this.bot!.api.editMessageText(peer.id, parseInt(messageId, 10), body));
    }
}
