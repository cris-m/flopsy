import type { Peer, OutboundMessage, ReactionOptions, Message, StreamingCapability } from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import { isSafeMediaUrl } from '@gateway/core/security';
import type { DiscordChannelConfig } from './types';

const INTERACTION_TTL_MS = 14 * 60_000;
const INTERACTION_SWEEP_MS = 60_000;
const MAX_PENDING_INTERACTIONS = 500;
const MAX_DISCORD_LENGTH = 2000;

export class DiscordChannel extends BaseChannel {
    readonly name = 'discord';
    readonly authType = 'token';
    readonly streaming: StreamingCapability = { editBased: true, minEditIntervalMs: 500 };

    private client: import('discord.js').Client | null = null;
    private readonly channelConfig: DiscordChannelConfig;
    private readonly pendingInteractions = new Map<string, { interaction: unknown; createdAt: number }>();
    private sweepTimer: ReturnType<typeof setInterval> | null = null;

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

            this.client.once(Events.ClientReady, async () => {
                try {
                    await this.setPresence();
                    await this.registerSlashCommands();
                } catch (err) {
                    this.emitError(toError(err));
                }
                this.setStatus('connected');
                this.emit('onAuthUpdate', 'authenticated');
            });

            this.client.on(Events.MessageCreate, async (msg) => {
                if (msg.author.bot) return;

                const isDM = msg.channel.type === ChannelType.DM;
                const peerType = isDM ? 'user' as const : 'group' as const;
                const peerId = isDM ? msg.author.id : msg.channelId;
                const senderId = msg.author.id;

                if (!isDM && !this.isGuildAllowed(msg.guildId, msg.channelId)) return;
                if (!this.isAllowed(peerId, peerType)) return;

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

            this.client.on(Events.InteractionCreate, async (interaction) => {
                if (!interaction.isChatInputCommand()) return;

                const senderId = interaction.user.id;
                const channelId = interaction.channelId;
                const isDM = !interaction.guildId;
                const peerId = isDM ? senderId : channelId;
                const peerType = isDM ? 'user' as const : 'group' as const;

                if (!channelId) {
                    await interaction.reply({ content: 'Unable to process.', ephemeral: true });
                    return;
                }

                if (!isDM && !this.isGuildAllowed(interaction.guildId, channelId)) {
                    await interaction.reply({ content: 'Not available here.', ephemeral: true });
                    return;
                }

                if (!this.isAllowed(peerId, peerType)) {
                    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
                    return;
                }

                const input = interaction.options.getString('input') ?? '';
                const normalized: Message = {
                    id: interaction.id,
                    channelName: this.name,
                    peer: { id: peerId, type: peerType },
                    sender: { id: senderId, name: interaction.user.username },
                    body: `/${interaction.commandName} ${input}`.trim(),
                    timestamp: new Date().toISOString(),
                };

                if (this.pendingInteractions.size >= MAX_PENDING_INTERACTIONS) {
                    await interaction.reply({ content: 'Too many pending requests. Try again later.', ephemeral: true });
                    return;
                }

                await interaction.deferReply();
                this.pendingInteractions.set(interaction.id, { interaction, createdAt: Date.now() });
                this.ensureSweep();
                await this.emit('onMessage', normalized);
            });

            await this.client.login(this.channelConfig.token);
        } catch (err) {
            this.setStatus('error');
            this.emitError(toError(err));
        }
    }

    async disconnect(): Promise<void> {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        this.pendingInteractions.clear();
        if (this.client) {
            await this.client.destroy();
            this.client = null;
        }
        this.setStatus('disconnected');
    }

    async send(message: OutboundMessage): Promise<string> {
        if (!this.client) throw new Error('Discord not connected');

        const files = this.buildFileAttachments(message);

        if (message.replyTo) {
            const pending = this.pendingInteractions.get(message.replyTo);
            if (pending) {
                this.pendingInteractions.delete(message.replyTo);
                const interaction = pending.interaction as import('discord.js').ChatInputCommandInteraction;
                const reply = await interaction.editReply({
                    content: (message.body ?? '').slice(0, MAX_DISCORD_LENGTH),
                    ...(files.length && { files }),
                });
                return reply.id;
            }
        }

        const channel = await this.resolveTextChannel(message.peer);

        if (files.length) {
            const sent = await channel.send({
                content: message.body ? message.body.slice(0, MAX_DISCORD_LENGTH) : undefined,
                files,
            });
            return sent.id;
        }

        const sent = await channel.send({
            content: (message.body ?? '').slice(0, MAX_DISCORD_LENGTH),
            ...(message.replyTo && { reply: { messageReference: message.replyTo } }),
        });
        return sent.id;
    }

    async sendTyping(peer: Peer): Promise<void> {
        if (!this.client) return;

        try {
            const channel = await this.resolveTextChannel(peer);
            await channel.sendTyping();
        } catch {}
    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.client) throw new Error('Discord not connected');

        const channel = await this.resolveTextChannel(options.peer);
        const msg = await channel.messages.fetch(options.messageId);

        if (options.remove) {
            const reaction = msg.reactions.cache.find((r) => r.emoji.name === options.emoji);
            if (reaction) await reaction.users.remove(this.client.user?.id);
        } else {
            await msg.react(options.emoji);
        }
    }

    async editMessage(messageId: string, peer: Peer, body: string): Promise<void> {
        if (!this.client) throw new Error('Discord not connected');
        const channel = await this.resolveTextChannel(peer);
        const msg = await channel.messages.fetch(messageId);
        await msg.edit(body.slice(0, MAX_DISCORD_LENGTH));
    }

    private async registerSlashCommands(): Promise<void> {
        const commands = this.channelConfig.slashCommands;
        if (!commands?.length || !this.client?.application) return;

        const { SlashCommandBuilder } = await import('discord.js');

        const builders = commands.map((cmd) =>
            new SlashCommandBuilder()
                .setName(cmd.name)
                .setDescription(cmd.description)
                .addStringOption((opt) => opt.setName('input').setDescription('Your message').setRequired(false))
                .toJSON(),
        );

        if (this.channelConfig.devGuildId) {
            const guild = await this.client.guilds.fetch(this.channelConfig.devGuildId);
            await guild.commands.set(builders);
        } else {
            const existing = await this.client.application.commands.fetch();
            const existingNames = new Set(existing.map((c) => c.name));
            const needsUpdate = commands.length !== existing.size || commands.some((c) => !existingNames.has(c.name));
            if (needsUpdate) {
                await this.client.application.commands.set(builders);
            }
        }
    }

    private async setPresence(): Promise<void> {
        if (!this.client?.user || !this.channelConfig.presence) return;

        const { ActivityType } = await import('discord.js');
        const p = this.channelConfig.presence;

        const activityTypeMap: Record<string, number> = {
            playing: ActivityType.Playing,
            streaming: ActivityType.Streaming,
            listening: ActivityType.Listening,
            watching: ActivityType.Watching,
            competing: ActivityType.Competing,
        };

        this.client.user.setPresence({
            status: p.status ?? 'online',
            activities: p.activity ? [{
                name: p.activity,
                type: activityTypeMap[p.activityType ?? 'playing'] ?? ActivityType.Playing,
                ...((p.activityType ?? 'playing') === 'streaming' && p.activityUrl && { url: p.activityUrl }),
            }] : [],
        });
    }

    private buildFileAttachments(message: OutboundMessage): { attachment: string; name: string }[] {
        if (!message.media?.length) return [];
        return message.media
            .filter((m) => isSafeMediaUrl(m.url))
            .map((m) => ({ attachment: m.url ?? m.data ?? '', name: m.fileName ?? 'file' }));
    }

    private isGuildAllowed(guildId: string | null, channelId: string): boolean {
        if (this.channelConfig.allowedGuilds?.length) {
            if (!guildId || !this.channelConfig.allowedGuilds.includes(guildId)) return false;
        }
        if (this.channelConfig.allowedChannels?.length) {
            if (!this.channelConfig.allowedChannels.includes(channelId)) return false;
        }
        return true;
    }

    private async resolveTextChannel(peer: Peer) {
        if (!this.client) throw new Error('Discord not connected');

        const channel = peer.type === 'user'
            ? await this.client.users.fetch(peer.id).then((u) => u.createDM())
            : await this.client.channels.fetch(peer.id);

        if (!channel || !('send' in channel)) {
            throw new Error(`Cannot resolve text channel for ${peer.id}`);
        }
        return channel as import('discord.js').DMChannel;
    }

    private ensureSweep(): void {
        if (this.sweepTimer) return;
        this.sweepTimer = setInterval(() => {
            const cutoff = Date.now() - INTERACTION_TTL_MS;
            for (const [id, entry] of this.pendingInteractions) {
                if (entry.createdAt < cutoff) this.pendingInteractions.delete(id);
            }
            if (this.pendingInteractions.size === 0) {
                clearInterval(this.sweepTimer!);
                this.sweepTimer = null;
            }
        }, INTERACTION_SWEEP_MS);
        this.sweepTimer.unref();
    }
}
