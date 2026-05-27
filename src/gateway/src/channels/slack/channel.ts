import type {
    Peer,
    OutboundMessage,
    ReactionOptions,
    Message,
    Media,
    StreamingCapability,
} from '@gateway/types';
import { isTextDocument } from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import type { SlackChannelConfig } from './types';

const MAX_TEXT_DOCUMENT_BYTES = 256 * 1024;

interface SlackFile {
    id?: string;
    name?: string;
    mimetype?: string;
    filetype?: string;
    size?: number;
    url_private_download?: string;
    url_private?: string;
}

export class SlackChannel extends BaseChannel {
    readonly name = 'slack';
    readonly authType = 'token';
    readonly streaming: StreamingCapability = { editBased: true, minEditIntervalMs: 1000 };

    private app: import('@slack/bolt').App | null = null;
    private botUserId: string | null = null;
    private readonly channelConfig: SlackChannelConfig;

    constructor(config: SlackChannelConfig) {
        super(config);
        this.channelConfig = config;
    }

    async connect(): Promise<void> {
        this.setStatus('connecting');

        try {
            const { App } = await import('@slack/bolt');
            this.app = new App({
                token: this.channelConfig.botToken,
                appToken: this.channelConfig.appToken,
                socketMode: true,
                signingSecret: this.channelConfig.signingSecret,
            });

            const auth = await this.app.client.auth.test({ token: this.channelConfig.botToken });
            this.botUserId = auth.user_id as string;

            this.app.message(async ({ message, client }) => {
                const msg = message as unknown as {
                    subtype?: string;
                    bot_id?: string;
                    text?: string;
                    channel_type?: string;
                    user?: string;
                    channel?: string;
                    ts?: string;
                    thread_ts?: string;
                    files?: SlackFile[];
                };
                if (msg.bot_id) return;
                const isFileShare = msg.subtype === 'file_share' && Array.isArray(msg.files) && msg.files.length > 0;
                if (msg.subtype && !isFileShare) return;
                if (!msg.text && !isFileShare) return;

                const isDm = msg.channel_type === 'im';
                const peerType = isDm ? ('user' as const) : ('group' as const);
                const senderId = msg.user ?? '';
                const peerId = msg.channel ?? '';

                if (!this.isAllowed(isDm ? senderId : peerId, peerType)) return;

                if (!isDm && this.channelConfig.groupActivation === 'mention') {
                    if (!msg.text?.includes(`<@${this.botUserId}>`)) return;
                }

                let senderName: string | undefined;
                try {
                    const info = await client.users.info({ user: senderId });
                    senderName = info.user?.real_name ?? info.user?.name;
                } catch (err) {
                    this.log.debug({ err, senderId }, 'slack users.info failed — senderName stays undefined');
                }

                let peerName: string | undefined;
                if (isDm) {
                    peerName = senderName;
                } else {
                    try {
                        const info = await client.conversations.info({ channel: peerId });
                        peerName = info.channel?.name;
                    } catch (err) {
                        this.log.debug({ err, peerId }, 'slack conversations.info failed — peerName stays undefined');
                    }
                }

                const media: Media[] = [];
                if (isFileShare && msg.files) {
                    for (const f of msg.files) {
                        const fileName = f.name;
                        const mimeType = f.mimetype;
                        const fileSize = f.size;
                        const downloadUrl = f.url_private_download ?? f.url_private;
                        const isText = isTextDocument(mimeType, fileName);
                        const withinSize = !fileSize || fileSize <= MAX_TEXT_DOCUMENT_BYTES;
                        if (downloadUrl && isText && withinSize) {
                            try {
                                const res = await fetch(downloadUrl, {
                                    headers: { Authorization: `Bearer ${this.channelConfig.botToken}` },
                                });
                                if (res.ok) {
                                    const buffer = await res.arrayBuffer();
                                    if (buffer.byteLength <= MAX_TEXT_DOCUMENT_BYTES) {
                                        const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
                                        media.push({ type: 'document', fileName, mimeType, fileSize, text });
                                        continue;
                                    }
                                }
                            } catch {
                                /* fall through to metadata-only */
                            }
                        }
                        media.push({ type: 'document', fileName, mimeType, fileSize });
                    }
                }

                const ts = msg.ts ?? '';
                const body = msg.text ?? (media.length > 0 ? `[${media[0]!.fileName ?? 'file'}]` : '');
                const normalized: Message = {
                    id: ts,
                    channelName: this.name,
                    peer: { id: peerId, type: peerType, name: peerName },
                    sender: { id: senderId, name: senderName },
                    body,
                    synthetic: !msg.text && media.length > 0 ? true : undefined,
                    timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
                    replyTo:
                        msg.thread_ts && msg.thread_ts !== ts ? { id: msg.thread_ts } : undefined,
                    media: media.length > 0 ? media : undefined,
                };

                await this.emit('onMessage', normalized);
            });

            await this.app.start();
            this.setStatus('connected');
            this.emit('onAuthUpdate', 'authenticated');
        } catch (err) {
            this.setStatus('error');
            this.emitError(toError(err));
        }
    }

    async disconnect(): Promise<void> {
        if (this.app) {
            await this.app.stop();
            this.app = null;
        }
        this.botUserId = null;
        this.setStatus('disconnected');
    }

    async send(message: OutboundMessage): Promise<string> {
        if (!this.app) throw new Error('Slack not connected');

        const channel = message.peer.id;
        const text = message.body ?? '';

        const result = await this.app.client.chat.postMessage({
            token: this.channelConfig.botToken,
            channel,
            text,
            ...(message.replyTo ? { thread_ts: message.replyTo } : {}),
        });

        return result.ts as string;
    }

    async sendTyping(_peer: Peer): Promise<void> {
    }

    /**
     * Delete a Slack message by timestamp. Used by reasoning auto-cleanup.
     * Slack requires `channel` (= peer.id) and `ts` (= messageId returned
     * from chat.postMessage). Failures swallowed — best-effort.
     */
    async deleteMessage(messageId: string, peer: Peer): Promise<void> {
        if (!this.app) return;
        try {
            await this.app.client.chat.delete({
                token: this.channelConfig.botToken,
                channel: peer.id,
                ts: messageId,
            });
        } catch {
            /* already gone, permission-denied, or stale ts — ignore */
        }
    }

    /**
     * Slack mrkdwn: no native spoilers/collapsibles, so the next-best
     * native styling is a `*bold*` header above a `>` blockquote. Slack
     * visually demotes blockquote text (grey vertical bar + dimmer fg)
     * so it reads as "secondary context" without competing with the answer.
     */
    override formatReasoning(content: string): string {
        const trimmed = content.trim();
        if (!trimmed) return '';
        const quoted = trimmed.split('\n').map((l) => `> ${l}`).join('\n');
        return `*💭 Reasoning*\n${quoted}`;
    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.app) throw new Error('Slack not connected');

        if (!options.emoji || options.remove) {
            const name = (options.emoji ?? '').replace(/:/g, '');
            await this.app.client.reactions.remove({
                token: this.channelConfig.botToken,
                channel: options.peer.id,
                timestamp: options.messageId,
                name,
            });
            return;
        }

        const name = options.emoji.replace(/:/g, '');
        await this.app.client.reactions.add({
            token: this.channelConfig.botToken,
            channel: options.peer.id,
            timestamp: options.messageId,
            name,
        });
    }

    async editMessage(messageId: string, peer: Peer, body: string): Promise<void> {
        if (!this.app) throw new Error('Slack not connected');
        await this.app.client.chat.update({
            token: this.channelConfig.botToken,
            channel: peer.id,
            ts: messageId,
            text: body,
        });
    }
}
