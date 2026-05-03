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
    ButtonStyle as OurButtonStyle,
} from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import { isSafeMediaUrl } from '@gateway/core/security';
import type { DiscordChannelConfig } from './types';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function downloadAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength > MAX_IMAGE_BYTES) return null;
        const ct = res.headers.get('content-type') ?? 'image/jpeg';
        return { data: Buffer.from(buffer).toString('base64'), mimeType: ct.split(';')[0]!.trim() };
    } catch {
        return null;
    }
}

// Discord ButtonStyle: Primary=1, Secondary=2, Success=3, Danger=4.
// Returning the numeric value avoids a build-time dependency.
function mapDiscordButtonStyle(style: OurButtonStyle | undefined): number {
    switch (style) {
        case 'success': return 3;
        case 'danger':  return 4;
        case 'secondary': return 2;
        case 'primary':
        default:        return 1;
    }
}

// Discord caps: 5 buttons/row, 5 rows/message, custom_id ≤ 100 chars.
function buildDiscordComponents(
    interactive: InteractiveReply,
): Array<{ type: 1; components: Array<{ type: 2; style: number; label: string; custom_id: string }> }> | undefined {
    const rows: Array<{ type: 1; components: Array<{ type: 2; style: number; label: string; custom_id: string }> }> = [];
    const ROW_SIZE = 5;

    for (const block of interactive.blocks) {
        if (block.type === 'buttons') {
            for (let i = 0; i < block.buttons.length; i += ROW_SIZE) {
                const row = block.buttons
                    .slice(i, i + ROW_SIZE)
                    .filter((b) => b.value.length <= 100)
                    .map((b) => ({
                        type: 2 as const,
                        style: mapDiscordButtonStyle(b.style),
                        label: b.label.slice(0, 80),
                        custom_id: b.value,
                    }));
                if (row.length > 0) rows.push({ type: 1, components: row });
            }
        } else if (block.type === 'select') {
            for (let i = 0; i < block.options.length; i += ROW_SIZE) {
                const row = block.options
                    .slice(i, i + ROW_SIZE)
                    .filter((o) => o.value.length <= 100)
                    .map((o) => ({
                        type: 2 as const,
                        style: 2,
                        label: o.label.slice(0, 80),
                        custom_id: o.value,
                    }));
                if (row.length > 0) rows.push({ type: 1, components: row });
            }
        }
    }

    return rows.length > 0 ? rows.slice(0, 5) : undefined;
}

const INTERACTION_TTL_MS = 14 * 60_000;
const INTERACTION_SWEEP_MS = 60_000;
const MAX_PENDING_INTERACTIONS = 500;
const MAX_DISCORD_LENGTH = 2000;

export class DiscordChannel extends BaseChannel {
    readonly name = 'discord';
    readonly authType = 'token';
    readonly streaming: StreamingCapability = { editBased: true, minEditIntervalMs: 500 };
    // Discord renders all of: action-row buttons, select menus, native polls,
    // rich components (cards/embeds). See runtime block wiring in
    // src/team/src/factory.ts — the agent reads this to pick tools.
    readonly capabilities: readonly InteractiveCapability[] = [
        'buttons',
        'select',
        'polls',
        'components',
        'reactions',
        'typing',
        'edit-message',
    ];

    private client: import('discord.js').Client | null = null;
    private readonly channelConfig: DiscordChannelConfig;
    private readonly pendingInteractions = new Map<
        string,
        { interaction: unknown; createdAt: number }
    >();
    private sweepTimer: ReturnType<typeof setInterval> | null = null;

    constructor(config: DiscordChannelConfig) {
        super(config);
        this.channelConfig = config;
    }

    async connect(): Promise<void> {
        this.setStatus('connecting');

        try {
            const { Client, GatewayIntentBits, Partials, Events, ChannelType } =
                await import('discord.js');

            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.DirectMessages,
                    GatewayIntentBits.MessageContent,
                    GatewayIntentBits.GuildMessageReactions,
                    // Required for MessagePollVoteAdd to fire.
                    GatewayIntentBits.GuildMessagePolls,
                    GatewayIntentBits.DirectMessagePolls,
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
                const peerType = isDM ? ('user' as const) : ('group' as const);
                const peerId = isDM ? msg.author.id : msg.channelId;
                const senderId = msg.author.id;

                if (!isDM && !this.isGuildAllowed(msg.guildId, msg.channelId)) return;
                if (!this.isAllowed(peerId, peerType)) return;

                if (!msg.content && msg.attachments.size === 0) return;

                const media: Media[] = [];
                for (const att of msg.attachments.values()) {
                    const ct = att.contentType ?? '';
                    if (ct.startsWith('image/') && att.size <= MAX_IMAGE_BYTES) {
                        const dl = await downloadAsBase64(att.url);
                        media.push(dl
                            ? { type: 'image', data: dl.data, mimeType: dl.mimeType, fileName: att.name }
                            : { type: 'image', url: att.url, mimeType: ct, fileName: att.name },
                        );
                    } else if (ct.startsWith('video/')) {
                        media.push({ type: 'video', url: att.url, mimeType: ct, fileName: att.name, fileSize: att.size });
                    } else {
                        media.push({ type: 'document', url: att.url, mimeType: ct || undefined, fileName: att.name, fileSize: att.size });
                    }
                }

                let body = msg.content;
                let synthetic = false;
                if (!body && media.length > 0) {
                    body = media[0]!.type === 'image' ? '[Image]' : `[${media[0]!.fileName ?? 'File'}]`;
                    synthetic = true;
                }

                const normalized: Message = {
                    id: msg.id,
                    channelName: this.name,
                    peer: {
                        id: peerId,
                        type: peerType,
                        name: isDM ? msg.author.username : (msg.channel as { name?: string }).name,
                    },
                    sender: { id: senderId, name: msg.author.username },
                    body,
                    synthetic: synthetic || undefined,
                    timestamp: msg.createdAt.toISOString(),
                    replyTo: msg.reference?.messageId ? { id: msg.reference.messageId } : undefined,
                    media: media.length > 0 ? media : undefined,
                };

                await this.emit('onMessage', normalized);
            });

            // Poll votes round-trip as synthesized user messages so the
            // agent reads vote signals via the normal pipeline.
            this.client.on(Events.MessagePollVoteAdd, async (pollAnswer, userId) => {
                try {
                    const answerText =
                        (pollAnswer as { text?: string }).text ??
                        `option ${(pollAnswer as { id?: number }).id ?? '?'}`;
                    const pollMsg = (pollAnswer as { poll?: { channelId?: string; messageId?: string } }).poll;
                    const channelId = pollMsg?.channelId;
                    if (!channelId) return;

                    // Try to resolve voter username — best effort.
                    let voterName: string | undefined;
                    try {
                        const user = await this.client!.users.fetch(userId);
                        voterName = user.username;
                    } catch {
                        /* fall through without name */
                    }

                    const fetched = await this.client!.channels.fetch(channelId).catch(() => null);
                    const isDM =
                        !fetched ||
                        ('type' in fetched && fetched.type === ChannelType.DM);
                    const peerId = isDM ? userId : channelId;
                    const peerType = (isDM ? 'user' : 'group') as 'user' | 'group';

                    const msg: Message = {
                        id: `poll:${channelId}:${pollMsg?.messageId ?? 'x'}:${userId}:${Date.now()}`,
                        channelName: this.name,
                        peer: { id: peerId, type: peerType, ...(voterName && { name: voterName }) },
                        ...(!isDM && voterName && {
                            sender: { id: userId, name: voterName },
                        }),
                        body: `Voted "${answerText}" in a poll.`,
                        timestamp: new Date().toISOString(),
                    };
                    await this.emit('onMessage', msg);
                } catch (err) {
                    this.log.warn({ err, op: 'pollVoteAdd' }, 'poll vote handler failed');
                }
            });

            this.client.on(Events.InteractionCreate, async (interaction) => {
                if (interaction.isButton()) {
                    const isDM = !interaction.guildId;
                    const peerId = isDM ? interaction.user.id : interaction.channelId ?? interaction.user.id;
                    const peerType = isDM ? ('user' as const) : ('group' as const);

                    if (!isDM && !this.isGuildAllowed(interaction.guildId, interaction.channelId!)) {
                        await interaction.reply({ content: 'Not available here.', ephemeral: true }).catch(() => {});
                        return;
                    }
                    if (!this.isAllowed(peerId, peerType)) {
                        await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {});
                        return;
                    }

                    // Silent ack — agent's reply carries the response.
                    await interaction.deferUpdate().catch(() => {});

                    const callback: InteractionCallback = {
                        type: 'button_click',
                        value: interaction.customId,
                        messageId: interaction.message.id,
                        peer: { id: peerId, type: peerType },
                        sender: {
                            id: interaction.user.id,
                            name: interaction.user.username,
                        },
                    };
                    await this.emit('onInteraction', callback);
                    return;
                }

                if (!interaction.isChatInputCommand()) return;

                const senderId = interaction.user.id;
                const channelId = interaction.channelId;
                const isDM = !interaction.guildId;
                const peerId = isDM ? senderId : channelId;
                const peerType = isDM ? ('user' as const) : ('group' as const);

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
                    await interaction.reply({
                        content: 'Too many pending requests. Try again later.',
                        ephemeral: true,
                    });
                    return;
                }

                await interaction.deferReply();
                this.pendingInteractions.set(interaction.id, {
                    interaction,
                    createdAt: Date.now(),
                });
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
        // discord.js accepts raw JSON components via the `components` field
        // when its types are loose; we build our own and cast to satisfy TS.
        const components = message.interactive
            ? buildDiscordComponents(message.interactive)
            : undefined;

        if (message.replyTo) {
            const pending = this.pendingInteractions.get(message.replyTo);
            if (pending) {
                this.pendingInteractions.delete(message.replyTo);
                const interaction =
                    pending.interaction as import('discord.js').ChatInputCommandInteraction;
                const reply = await interaction.editReply({
                    content: (message.body ?? '').slice(0, MAX_DISCORD_LENGTH),
                    ...(files.length && { files }),
                    ...(components && { components: components as unknown as never }),
                });
                return reply.id;
            }
        }

        const channel = await this.resolveTextChannel(message.peer);

        if (files.length) {
            const sent = await channel.send({
                content: message.body ? message.body.slice(0, MAX_DISCORD_LENGTH) : undefined,
                files,
                ...(components && { components: components as unknown as never }),
            });
            return sent.id;
        }

        // Reply-threading is clutter in DMs (single counterparty).
        const isDM = message.peer.type === 'user';
        const sent = await channel.send({
            content: (message.body ?? '').slice(0, MAX_DISCORD_LENGTH),
            ...(!isDM && message.replyTo && { reply: { messageReference: message.replyTo } }),
            ...(components && { components: components as unknown as never }),
        });
        return sent.id;
    }

    /**
     * Native Discord poll using discord.js's `PollData` shape (camelCase, flat
     * answers — NOT the raw API schema). Caps: question ≤ 300, 2-10 options
     * ≤ 55 each, duration 1-768 hours.
     */
    async sendPoll(args: {
        peer: Peer;
        question: string;
        options: readonly string[];
        anonymous?: boolean;
        allowMultiple?: boolean;
        durationHours?: number;
    }): Promise<string> {
        if (!this.client) throw new Error('Discord not connected');
        const channel = await this.resolveTextChannel(args.peer);
        const durationHours = Math.min(
            768,
            Math.max(1, Math.round(args.durationHours ?? 24)),
        );
        const sent = await channel.send({
            poll: {
                question: { text: args.question.slice(0, 300) },
                answers: args.options.slice(0, 10).map((o) => ({
                    text: o.slice(0, 55),
                })),
                duration: durationHours,
                allowMultiselect: args.allowMultiple ?? false,
                layoutType: 1,
            },
        } as unknown as never);
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
                .addStringOption((opt) =>
                    opt.setName('input').setDescription('Your message').setRequired(false),
                )
                .toJSON(),
        );

        if (this.channelConfig.devGuildId) {
            const guild = await this.client.guilds.fetch(this.channelConfig.devGuildId);
            await guild.commands.set(builders);
        } else {
            const existing = await this.client.application.commands.fetch();
            const existingNames = new Set(existing.map((c) => c.name));
            const needsUpdate =
                commands.length !== existing.size ||
                commands.some((c) => !existingNames.has(c.name));
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
            activities: p.activity
                ? [
                      {
                          name: p.activity,
                          type:
                              activityTypeMap[p.activityType ?? 'playing'] ?? ActivityType.Playing,
                          ...((p.activityType ?? 'playing') === 'streaming' &&
                              p.activityUrl && { url: p.activityUrl }),
                      },
                  ]
                : [],
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

        const channel =
            peer.type === 'user'
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
