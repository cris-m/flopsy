import { loadConfig, type FlopsyConfig, workspace } from '@flopsy/shared';
import type { Channel, Message, WebhookChannel } from '@gateway/types';
import { isWebhookChannel } from '@gateway/types';
import { BaseGateway } from '@gateway/core/base-gateway';
import { WebhookServer } from '@gateway/core/base-webhook';
import { MessageRouter } from '@gateway/core/message-router';
import { WebhookRouter, type ExternalWebhookConfig } from '@gateway/core/webhook-router';
import type { AgentHandler } from '@gateway/types/agent';
import { ProactiveEngine } from './proactive';
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
    private proactiveEngine: ProactiveEngine | null = null;
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

        if (cfg.proactive.webhooks.length > 0) {
            this.registerExternalWebhooks(cfg.proactive.webhooks);
            this.log.info(
                {
                    count: cfg.proactive.webhooks.length,
                    names: cfg.proactive.webhooks.map((w) => w.name),
                },
                'external webhooks registered',
            );
        }

        this.logConfigSummary(cfg);
    }

    private logConfigSummary(cfg: FlopsyConfig): void {
        const enabledChannels = Object.entries(cfg.channels)
            .filter(([, ch]) => (ch as { enabled?: boolean }).enabled)
            .map(([name]) => name);

        const { proactive } = cfg;

        const enabledNames = <T extends { enabled: boolean; name: string }>(items: T[]) =>
            items.filter((i) => i.enabled).map((i) => i.name);

        this.log.debug(
            {
                gateway: {
                    host: cfg.gateway.host,
                    port: cfg.gateway.port,
                    coalesceMs: cfg.gateway.coalesceDelayMs,
                },
                channels: { enabled: enabledChannels, total: Object.keys(cfg.channels).length },
                webhook: {
                    enabled: cfg.webhook.enabled,
                    port: cfg.webhook.enabled ? cfg.webhook.port : undefined,
                },
                proactive: {
                    enabled: proactive.enabled,
                    heartbeats: proactive.heartbeats.enabled
                        ? {
                              count: proactive.heartbeats.heartbeats.length,
                              names: enabledNames(proactive.heartbeats.heartbeats),
                          }
                        : false,
                    scheduler: proactive.scheduler.enabled
                        ? {
                              count: proactive.scheduler.jobs.length,
                              names: enabledNames(proactive.scheduler.jobs),
                          }
                        : false,
                    webhooks:
                        proactive.webhooks.length > 0
                            ? {
                                  count: proactive.webhooks.length,
                                  names: proactive.webhooks.map((w) => w.name),
                              }
                            : false,
                    healthMonitor: proactive.healthMonitor.enabled,
                },
                timezone: cfg.timezone,
            },
            'config loaded',
        );
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

    registerExternalWebhooks(configs: ExternalWebhookConfig[]): void {
        this.webhookRouter = new WebhookRouter(configs);
        if (this.webhookServer && this.router) {
            this.webhookRouter.register(this.webhookServer, this.router);
        }
    }

    private registerChannels(cfg: FlopsyConfig): void {
        const { channels } = cfg;

        if (channels.whatsapp.enabled) {
            this.register(
                new WhatsAppChannel({
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
                }),
            );
        }

        if (channels.telegram.enabled) {
            this.register(
                new TelegramChannel({
                    enabled: true,
                    dmPolicy: channels.telegram.dm.policy,
                    allowFrom: channels.telegram.dm.allowFrom,
                    blockedFrom: channels.telegram.dm.blockedFrom,
                    groupPolicy: channels.telegram.group.policy,
                    allowedGroups: channels.telegram.group.allowedGroups,
                    token: channels.telegram.token,
                    groupActivation: channels.telegram.group.activation,
                }),
            );
        }

        if (channels.discord.enabled) {
            const dc = channels.discord;
            this.register(
                new DiscordChannel({
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
                }),
            );
        }

        if (channels.line.enabled) {
            this.register(
                new LineChannel({
                    enabled: true,
                    dmPolicy: channels.line.dm.policy,
                    allowFrom: channels.line.dm.allowFrom,
                    blockedFrom: channels.line.dm.blockedFrom,
                    groupPolicy: channels.line.group.policy,
                    allowedGroups: channels.line.group.allowedGroups,
                    channelAccessToken: channels.line.channelAccessToken,
                    channelSecret: channels.line.channelSecret,
                    webhookPath: channels.line.webhookPath,
                }),
            );
        }

        if (channels.signal.enabled) {
            this.register(
                new SignalChannel({
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
                }),
            );
        }

        if (channels.imessage.enabled) {
            this.register(
                new IMessageChannel({
                    enabled: true,
                    dmPolicy: channels.imessage.dm.policy,
                    allowFrom: channels.imessage.dm.allowFrom,
                    blockedFrom: channels.imessage.dm.blockedFrom,
                    cliPath: channels.imessage.cliPath,
                    selfChatMode: channels.imessage.selfChatMode,
                }),
            );
        }

        if (channels.slack?.enabled) {
            this.register(
                new SlackChannel({
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
                }),
            );
        }

        if (channels.googlechat?.enabled) {
            this.register(
                new GoogleChatChannel({
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
                }),
            );
        }
    }

    getProactiveEngine(): ProactiveEngine | null {
        return this.proactiveEngine;
    }

    protected getProactiveHealth(): Record<string, unknown> {
        const { proactive } = this.cfg;
        const cron = this.proactiveEngine?.getCronTrigger();
        const heartbeat = this.proactiveEngine?.getHeartbeat();

        const jobSource = cron?.listJobs() ?? proactive.scheduler.jobs;
        const jobSummary = jobSource.map((j) => ({
            id: j.id,
            name: j.name,
            enabled: j.enabled,
            schedule: j.schedule,
        }));

        return {
            enabled: proactive.enabled,
            running: this.proactiveEngine?.isRunning() ?? false,
            statePath: proactive.statePath,
            retryQueuePath: proactive.retryQueuePath,
            heartbeats: {
                enabled: proactive.heartbeats.enabled,
                active: !!heartbeat,
                configured: proactive.heartbeats.heartbeats.filter((h) => h.enabled).length,
            },
            scheduler: {
                enabled: proactive.scheduler.enabled,
                active: !!cron,
                configured: proactive.scheduler.jobs.filter((j) => j.enabled).length,
                jobs: jobSummary,
            },
            webhooks: {
                configured: proactive.webhooks.length,
                names: proactive.webhooks.map((w) => w.name),
            },
            healthMonitor: {
                enabled: proactive.healthMonitor.enabled,
                checkIntervalMs: proactive.healthMonitor.checkIntervalMs,
                staleEventThresholdMs: proactive.healthMonitor.staleEventThresholdMs,
            },
        };
    }

    protected async onStart(): Promise<void> {
        const wh = this.cfg.webhook;
        if (wh.enabled) {
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

            this.log.info({ port: wh.port, host: wh.host }, 'webhook server started');
        } else {
            this.log.debug('webhook server disabled');
        }

        if (this.cfg.proactive.enabled) {
            this.log.info('proactive engine starting');

            const { proactive } = this.cfg;

            this.proactiveEngine = new ProactiveEngine({
                statePath: workspace.state('proactive.json'),
                retryQueuePath: workspace.state('retry-queue.json'),
                healthMonitor: proactive.healthMonitor.enabled
                    ? proactive.healthMonitor
                    : undefined,
            });

            await this.proactiveEngine.start(
                (name) => this.channels.get(name)?.status === 'connected',
                async (name, peer, text) => {
                    const ch = this.channels.get(name);
                    if (!ch) return undefined;
                    return ch.send({ peer, body: text });
                },
                async (message) => {
                    this.log.warn(
                        { message: message.slice(0, 80) },
                        'agent caller not yet wired — proactive job skipped',
                    );
                    return { response: '' };
                },
                async (threadId) => {
                    this.log.debug({ threadId }, 'thread cleaner not yet wired');
                },
                () => this.channels,
            );

            const defaultDelivery = proactive.delivery ?? {
                channelName: '',
                peer: { id: '', type: 'user' as const },
            };

            if (proactive.heartbeats.enabled && proactive.heartbeats.heartbeats.length > 0) {
                await this.proactiveEngine.startHeartbeats(
                    proactive.heartbeats.heartbeats,
                    defaultDelivery,
                );
            }

            if (proactive.scheduler.enabled && proactive.scheduler.jobs.length > 0) {
                await this.proactiveEngine.startCronJobs(proactive.scheduler.jobs, defaultDelivery);
            }

            this.log.info('proactive engine started');
        } else {
            this.log.debug('proactive engine disabled');
        }

        if (this.cfg.proactive.healthMonitor.enabled) {
            this.log.info(
                {
                    checkIntervalMs: this.cfg.proactive.healthMonitor.checkIntervalMs,
                    staleThresholdMs: this.cfg.proactive.healthMonitor.staleEventThresholdMs,
                },
                'health monitor enabled',
            );
        } else {
            this.log.debug('health monitor disabled');
        }
    }

    protected async onStop(): Promise<void> {
        if (this.proactiveEngine) {
            this.log.info('stopping proactive engine');
            await this.proactiveEngine.stop();
            this.proactiveEngine = null;
        }

        if (this.router) {
            this.log.debug('stopping message router');
            await this.router.stopAll();
            this.router = null;
        }

        if (this.webhookServer) {
            this.log.debug('stopping webhook server');
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
                this.webhookServer!.respond(res, 401, {
                    error: `Invalid ${channel.name} webhook signature`,
                });
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
                await channel
                    .handleWebhookEvent(event)
                    .catch((err) =>
                        this.log.error({ err, channel: channel.name }, 'webhook event error'),
                    );
            }
        });
    }

    protected async route(message: Message): Promise<void> {
        this.log.debug(
            {
                channel: message.channelName,
                from: message.sender?.name ?? message.sender?.id ?? message.peer.id,
                peer: message.peer.type,
                body: message.body.slice(0, 100),
            },
            'inbound message',
        );

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

        const ack = (
            channelCfg as { ackReaction?: { emoji: string; direct: boolean; group: string } }
        ).ackReaction;
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
