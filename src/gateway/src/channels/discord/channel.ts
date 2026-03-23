import type { Peer, OutboundMessage, ReactionOptions, Message } from '@gateway/types';
import { BaseChannel } from '@gateway/core/base-channel';
import type { DiscordChannelConfig } from './types';

export class DiscordChannel extends BaseChannel {
    readonly name = 'discord';
    readonly authType = 'token' as const;

    private client: import('discord.js').Client | null = null;
    private readonly channelConfig: DiscordChannelConfig;

    constructor(config: DiscordChannelConfig) {
        super(config);
        this.channelConfig = config;
    }

    async connect(): Promise<void> {
        this.setStatus('connecting');

        try {
            const { Client, GatewayIntentBits, Partials, Events, ChannelType } = await import('discord.js');

            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.DirectMessages,
                    GatewayIntentBits.MessageContent,
                    GatewayIntentBits.GuildMessageReactions,
                ],
                partials: [Partials.Channel, Partials.Message],
            });

            this.client.once(Events.ClientReady, () => {
                this.setStatus('connected');
                this.emit('onAuthUpdate', 'authenticated');
            });

            this.client.on(Events.MessageCreate, async (msg) => {
                if (msg.author.bot) return;

                const isDM = msg.channel.type === ChannelType.DM;
                const peerType = isDM ? 'user' as const : 'group' as const;
                const peerId = isDM ? msg.author.id : msg.channelId;
                const senderId = msg.author.id;

                if (!isDM && this.channelConfig.allowedGuilds?.length) {
                    if (!msg.guildId || !this.channelConfig.allowedGuilds.includes(msg.guildId)) return;
                }

                if (!isDM && this.channelConfig.allowedChannels?.length) {
                    if (!this.channelConfig.allowedChannels.includes(msg.channelId)) return;
                }

                if (!this.isAllowed(senderId, peerType)) return;

                const normalized: Message = {
                    id: msg.id,
                    channelName: this.name,
                    peer: { id: peerId, type: peerType, name: isDM ? msg.author.username : (msg.channel as { name?: string }).name },
                    sender: { id: senderId, name: msg.author.username },
                    body: msg.content,
                    timestamp: msg.createdAt.toISOString(),
                    replyTo: msg.reference?.messageId
                        ? { id: msg.reference.messageId }
                        : undefined,
                };

                await this.emit('onMessage', normalized);
            });

            await this.client.login(this.channelConfig.token);
        } catch (err) {
            this.setStatus('error');
            this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.destroy();
            this.client = null;
        }
        this.setStatus('disconnected');
    }

    async send(message: OutboundMessage): Promise<string> {
        if (!this.client) throw new Error('Discord not connected');

        const channel = await this.client.channels.fetch(message.peer.id);
        if (!channel || !('send' in channel)) {
            throw new Error(`Cannot send to channel ${message.peer.id}`);
        }

        const sendable = channel as Extract<typeof channel, { send: Function }>;

        if (message.media?.length) {
            const files = message.media.map((m) => ({
                attachment: m.url ?? m.data ?? '',
                name: m.fileName ?? 'file',
            }));
            const sent = await sendable.send({
                content: message.body ?? undefined,
                files,
            });
            return sent.id;
        }

        const sent = await sendable.send({
            content: message.body ?? '',
            ...(message.replyTo && { reply: { messageReference: message.replyTo } }),
        });
        return sent.id;
    }

    async sendTyping(peer: Peer): Promise<void> {
        if (!this.client) return;

        try {
            const channel = await this.client.channels.fetch(peer.id);
            if (channel && 'sendTyping' in channel) {
                await (channel as Extract<typeof channel, { sendTyping: Function }>).sendTyping();
            }
        } catch {}

    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.client) throw new Error('Discord not connected');

        const channel = await this.client.channels.fetch(options.peer.id);
        if (!channel || !('messages' in channel)) {
            throw new Error(`Cannot react in channel ${options.peer.id}`);
        }

        const textChannel = channel as import('discord.js').TextBasedChannel & { messages: import('discord.js').MessageManager };
        const msg = await textChannel.messages.fetch(options.messageId);

        if (options.remove) {
            const reaction = msg.reactions.cache.find((r) => r.emoji.name === options.emoji);
            if (reaction) await reaction.users.remove(this.client.user?.id);
        } else {
            await msg.react(options.emoji);
        }
    }
}
