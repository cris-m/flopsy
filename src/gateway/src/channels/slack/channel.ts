import type { Peer, OutboundMessage, ReactionOptions, Message, StreamingCapability } from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import type { SlackChannelConfig } from './types';

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
                    subtype?: string; bot_id?: string; text?: string;
                    channel_type?: string; user?: string; channel?: string;
                    ts?: string; thread_ts?: string;
                };
                if (msg.subtype || msg.bot_id || !msg.text) return;

                const isDm = msg.channel_type === 'im';
                const peerType = isDm ? 'user' as const : 'group' as const;
                const senderId = msg.user ?? '';
                const peerId = msg.channel ?? '';

                if (!this.isAllowed(isDm ? senderId : peerId, peerType)) return;

                if (!isDm && this.channelConfig.groupActivation === 'mention') {
                    if (!msg.text.includes(`<@${this.botUserId}>`)) return;
                }

                let senderName: string | undefined;
                try {
                    const info = await client.users.info({ user: senderId });
                    senderName = info.user?.real_name ?? info.user?.name;
                } catch {}

                let peerName: string | undefined;
                if (isDm) {
                    peerName = senderName;
                } else {
                    try {
                        const info = await client.conversations.info({ channel: peerId });
                        peerName = info.channel?.name;
                    } catch {}
                }

                const ts = msg.ts ?? '';
                const normalized: Message = {
                    id: ts,
                    channelName: this.name,
                    peer: { id: peerId, type: peerType, name: peerName },
                    sender: { id: senderId, name: senderName },
                    body: msg.text,
                    timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
                    replyTo: msg.thread_ts && msg.thread_ts !== ts
                        ? { id: msg.thread_ts }
                        : undefined,
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
        // Slack has no typing indicator API for bots
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
