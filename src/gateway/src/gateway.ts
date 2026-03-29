import { loadConfig, type FlopsyConfig } from '@flopsy/shared';
import type { Channel, Message, WebhookChannel } from '@gateway/types';
import { isWebhookChannel } from '@gateway/types';
import { BaseGateway } from '@gateway/core/base-gateway';
import { WebhookServer } from '@gateway/core/base-webhook';
import { MessageRouter } from '@gateway/core/message-router';
import { WebhookRouter, type ExternalWebhookConfig } from '@gateway/core/webhook-router';
import type { AgentHandler } from '@gateway/types/agent';
import { WhatsAppChannel } from '@gateway/channels/whatsapp';
import { TelegramChannel } from '@gateway/channels/telegram';
import { DiscordChannel } from '@gateway/channels/discord';
import { LineChannel } from '@gateway/channels/line';
import { SignalChannel } from '@gateway/channels/signal';
import { IMessageChannel } from '@gateway/channels/imessage';
import { SlackChannel } from '@gateway/channels/slack';
import { GoogleChatChannel } from '@gateway/channels/googlechat';

export class FlopsyGateway extends BaseGateway {
    private webhookServer: WebhookServer | null = null;
    private webhookRouter: WebhookRouter | null = null;
    private router: MessageRouter | null = null;
    private readonly cfg: FlopsyConfig;

    constructor(config?: FlopsyConfig) {
        const cfg = config ?? loadConfig();

        super({
            host: cfg.gateway.host,
            port: cfg.gateway.port,
            token: cfg.gateway.token,
            deduplicationTtlMs: cfg.gateway.deduplication.ttlMs,
            maxDeduplicationEntries: cfg.gateway.deduplication.maxEntries,
            rateLimit: cfg.gateway.rateLimit,
        });

        this.cfg = cfg;
        this.registerChannels(cfg);

        if (cfg.externalWebhooks.length > 0) {
            this.registerExternalWebhooks(cfg.externalWebhooks);
        }
    }

    setAgentHandler(handler: AgentHandler): void {
        this.router = new MessageRouter({
            agentHandler: handler,
            coalesceDelayMs: this.cfg.gateway.coalesceDelayMs,
        });

        for (const channel of this.channels.values()) {
            this.router.registerChannel(channel);
        }

        if (this.webhookRouter && this.webhookServer) {
            this.webhookRouter.register(this.webhookServer, this.router);
        }
    }

    /**
     * Register external webhook endpoints (GitHub, Stripe, etc.) that push
     * events into the agent via channel worker event queues.
     * Call before start() so routes are ready when the webhook server starts.
     */
    registerExternalWebhooks(configs: ExternalWebhookConfig[]): void {
        this.webhookRouter = new WebhookRouter(configs);
        if (this.webhookServer && this.router) {
            this.webhookRouter.register(this.webhookServer, this.router);
        }
    }

    private registerChannels(cfg: FlopsyConfig): void {
        const { channels } = cfg;

        if (channels.whatsapp.enabled) {
            this.register(new WhatsAppChannel({
                enabled: true,
                dmPolicy: channels.whatsapp.dm.policy,
                allowFrom: channels.whatsapp.dm.allowFrom,
                blockedFrom: channels.whatsapp.dm.blockedFrom,
                groupPolicy: channels.whatsapp.group.policy,
                allowedGroups: channels.whatsapp.group.allowedGroups,
                sessionPath: channels.whatsapp.sessionPath,
                contextMessages: channels.whatsapp.contextMessages,
                maxChunkSize: channels.whatsapp.maxChunkSize,
                sendReadReceipts: channels.whatsapp.sendReadReceipts,
                autoTyping: channels.whatsapp.autoTyping,
                selfChatMode: channels.whatsapp.selfChatMode,
            }));
        }

        if (channels.telegram.enabled) {
            this.register(new TelegramChannel({
                enabled: true,
                dmPolicy: channels.telegram.dm.policy,
                allowFrom: channels.telegram.dm.allowFrom,
                blockedFrom: channels.telegram.dm.blockedFrom,
                groupPolicy: channels.telegram.group.policy,
                allowedGroups: channels.telegram.group.allowedGroups,
                token: channels.telegram.token,
                groupActivation: channels.telegram.group.activation,
            }));
        }

        if (channels.discord.enabled) {
            const dc = channels.discord;
            this.register(new DiscordChannel({
                enabled: true,
                dmPolicy: dc.dm.policy,
                allowFrom: dc.dm.allowFrom,
                blockedFrom: dc.dm.blockedFrom,
                groupPolicy: dc.guild.policy,
                allowedGroups: dc.guild.allowedGuilds,
                token: dc.token,
                allowedGuilds: dc.guild.allowedGuilds,
                allowedChannels: dc.guild.allowedChannels,
                presence: dc.presence,
                slashCommands: dc.slashCommands,
                devGuildId: dc.devGuildId,
            }));
        }

        if (channels.line.enabled) {
            this.register(new LineChannel({
                enabled: true,
                dmPolicy: channels.line.dm.policy,
                allowFrom: channels.line.dm.allowFrom,
                blockedFrom: channels.line.dm.blockedFrom,
                groupPolicy: channels.line.group.policy,
                allowedGroups: channels.line.group.allowedGroups,
                channelAccessToken: channels.line.channelAccessToken,
                channelSecret: channels.line.channelSecret,
                webhookPath: channels.line.webhookPath,
            }));
        }

        if (channels.signal.enabled) {
            this.register(new SignalChannel({
                enabled: true,
                dmPolicy: channels.signal.dm.policy,
                allowFrom: channels.signal.dm.allowFrom,
                blockedFrom: channels.signal.dm.blockedFrom,
                groupPolicy: channels.signal.group.policy,
                allowedGroups: channels.signal.group.allowedGroups,
                account: channels.signal.account,
                cliPath: channels.signal.cliPath,
                deviceName: channels.signal.deviceName,
                sessionPath: channels.signal.sessionPath,
                groupActivation: channels.signal.group.activation,
            }));
        }

        if (channels.imessage.enabled) {
            this.register(new IMessageChannel({
                enabled: true,
                dmPolicy: channels.imessage.dm.policy,
                allowFrom: channels.imessage.dm.allowFrom,
                blockedFrom: channels.imessage.dm.blockedFrom,
                cliPath: channels.imessage.cliPath,
                selfChatMode: channels.imessage.selfChatMode,
            }));
        }

        if (channels.slack?.enabled) {
            this.register(new SlackChannel({
                enabled: true,
                dmPolicy: channels.slack.dm.policy,
                allowFrom: channels.slack.dm.allowFrom,
                blockedFrom: channels.slack.dm.blockedFrom,
                groupPolicy: channels.slack.group?.policy,
                allowedGroups: channels.slack.group?.allowedGroups,
                botToken: channels.slack.botToken,
                appToken: channels.slack.appToken,
                signingSecret: channels.slack.signingSecret,
                groupActivation: channels.slack.group?.activation,
            }));
        }

        if (channels.googlechat?.enabled) {
            this.register(new GoogleChatChannel({
                enabled: true,
                dmPolicy: channels.googlechat.dm.policy,
                allowFrom: channels.googlechat.dm.allowFrom,
                blockedFrom: channels.googlechat.dm.blockedFrom,
                groupPolicy: channels.googlechat.group?.policy,
                allowedGroups: channels.googlechat.group?.allowedGroups,
                serviceAccountKeyPath: channels.googlechat.serviceAccountKeyPath,
                serviceAccountKey: channels.googlechat.serviceAccountKey,
                verificationToken: channels.googlechat.verificationToken,
                webhookPath: channels.googlechat.webhookPath,
                groupActivation: channels.googlechat.group?.activation,
            }));
        }
    }

    protected async onStart(): Promise<void> {
        const wh = this.cfg.webhook;
        if (!wh.enabled) return;

        this.webhookServer = new WebhookServer();
        this.registerWebhookRoutes();

        if (this.webhookRouter && this.router) {
            this.webhookRouter.register(this.webhookServer, this.router);
        }

        await this.webhookServer.start({
            port: wh.port,
            host: wh.host,
            secret: wh.secret ?? undefined,
            allowedIps: wh.allowedIps.length ? wh.allowedIps : undefined,
        });
    }

    protected async onStop(): Promise<void> {
        if (this.router) {
            await this.router.stopAll();
            this.router = null;
        }

        if (this.webhookServer) {
            await this.webhookServer.stop();
            this.webhookServer = null;
        }
    }

    private registerWebhookRoutes(): void {
        if (!this.webhookServer) return;

        for (const channel of this.channels.values()) {
            if (isWebhookChannel(channel)) {
                this.registerWebhookChannel(channel);
            }
        }
    }

    private registerWebhookChannel(channel: Channel & WebhookChannel): void {
        this.webhookServer!.registerRoute(channel.webhookPath, async (req, body, res) => {
            if (!channel.verifyWebhook(req, body)) {
                this.webhookServer!.respond(res, 401, { error: `Invalid ${channel.name} webhook signature` });
                return;
            }

            const parsed = this.webhookServer!.parseJson(body);
            if (!parsed || typeof parsed !== 'object') {
                this.webhookServer!.respond(res, 400, { error: 'Invalid JSON' });
                return;
            }

            const events = channel.extractEvents(parsed);
            if (events.length === 0) {
                this.webhookServer!.respond(res, 200, { status: 'ok', events: 0 });
                return;
            }

            this.webhookServer!.respond(res, 200, { status: 'ok' });

            for (const event of events) {
                await channel.handleWebhookEvent(event)
                    .catch((err) => this.log.error({ err, channel: channel.name }, 'webhook event error'));
            }
        });
    }

    protected async route(message: Message): Promise<void> {
        this.log.debug({
            channel: message.channelName,
            from: message.sender?.name ?? message.sender?.id ?? message.peer.id,
            peer: message.peer.type,
            body: message.body.slice(0, 100),
        }, 'inbound message');

        await this.ackReact(message);

        if (!this.router) {
            this.log.warn('no agent handler configured - message not routed');
            return;
        }

        const channel = this.getChannel(message.channelName);
        if (!channel) return;

        await this.router.route(message, channel);
    }

    private async ackReact(message: Message): Promise<void> {
        const channelCfg = this.cfg.channels[message.channelName as keyof typeof this.cfg.channels];
        if (!channelCfg) return;

        const ack = (channelCfg as { ackReaction?: { emoji: string; direct: boolean; group: string } }).ackReaction;
        if (!ack?.emoji) return;

        const isGroup = message.peer.type === 'group' || message.peer.type === 'channel';
        if (isGroup && ack.group === 'never') return;
        if (!isGroup && !ack.direct) return;

        const channel = this.getChannel(message.channelName);
        if (!channel) return;

        try {
            await channel.react({ messageId: message.id, peer: message.peer, emoji: ack.emoji });
        } catch {
            this.log.debug({ channel: message.channelName }, 'ack reaction failed');
        }
    }
}
