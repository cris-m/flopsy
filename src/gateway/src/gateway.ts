import {
    loadConfig,
    type FlopsyConfig,
    workspace,
    copyPromptFile,
    resolveOrCreateMgmtToken,
    resolveWorkspaceConfigPath,
    validateExternalPromptFile,
    validatePathIdentifier,
    validateScriptPath,
    RELOAD_RULES_META,
} from '@flopsy/shared';

import { setDndFacade } from './commands/dnd-facade';
import { setScheduleFacade } from './commands/schedule-facade';
import { HookRegistry, discoverAndLoadHooks, emitHook, emitHookAwait, getHookRegistry, setHookRegistry } from './hooks';
import { peerFromKey } from './core/routing-key';
import { setMcpFacade } from './commands/mcp-facade';
import { setPlanFacade } from './commands/plan-facade';
import { setSessionFacade } from './commands/session-facade';
import { setCompactFacade } from './commands/compact-facade';
import { setGoalFacade } from './commands/goal-facade';
import { runCleanup } from '@flopsy/shared';
import { randomBytes } from 'node:crypto';
import type { Channel, Message, WebhookChannel } from '@gateway/types';
import { isWebhookChannel } from '@gateway/types';
import { BaseGateway } from '@gateway/core/base-gateway';
import { WebhookServer } from '@gateway/core/base-webhook';
import { MessageRouter } from '@gateway/core/message-router';
import { WebhookRouter, type ExternalWebhookConfig } from '@gateway/core/webhook-router';
import type { AgentHandler } from '@gateway/types/agent';
import { ProactiveEngine, type ProactiveEmbedder } from './proactive';
import { buildAgentCaller } from './proactive/agent-bridge';
import { getSharedLearningStore, getSharedPairingStore } from '@flopsy/team';
import { OllamaEmbedder, invalidateSkillCatalogs, type BaseChatModel } from 'flopsygraph';
import { ManagementServer } from './management/server';
import { ChatHandler } from './management/chat-handler';
import { ConfigReloader, type ReloadRule, type ReloadHandlerContext } from './config-reload';
import { CredentialRefreshScheduler } from './auth/credential-refresh-scheduler';
import { getConfigPath } from '@flopsy/shared';
import { WhatsAppChannel } from '@gateway/channels/whatsapp';
import { TelegramChannel } from '@gateway/channels/telegram';
import { DiscordChannel } from '@gateway/channels/discord';
import { LineChannel } from '@gateway/channels/line';
import { SignalChannel } from '@gateway/channels/signal';
import { IMessageChannel } from '@gateway/channels/imessage';
import { SlackChannel } from '@gateway/channels/slack';
import { GoogleChatChannel } from '@gateway/channels/googlechat';
import { ChatChannel } from '@gateway/channels/chat';

export class FlopsyGateway extends BaseGateway {
    private webhookServer: WebhookServer | null = null;
    private webhookRouter: WebhookRouter | null = null;
    private router: MessageRouter | null = null;
    private proactiveEngine: ProactiveEngine | null = null;
    private mgmtServer: ManagementServer | null = null;
    private configReloader: ConfigReloader | null = null;
    private credentialRefresher: CredentialRefreshScheduler | null = null;
    private agentHandler: AgentHandler | null = null;
    private chatChannel: ChatChannel | null = null;
    /** When the gateway booted (ms epoch). Used for uptime in hook contexts. */
    private startedAtMs?: number;
    private cfg: FlopsyConfig;

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

        // Always construct WebhookRouter when webhook server is enabled — runtime
        // adds and persisted routes need a router to register on.
        if (cfg.webhook?.enabled) {
            this.registerExternalWebhooks([]);
            this.log.info('webhook router ready (runtime adds welcome)');
        }

        this.logConfigSummary(cfg);
    }

    private logConfigSummary(cfg: FlopsyConfig): void {
        const enabledChannels = Object.entries(cfg.channels)
            .filter(([, ch]) => (ch as { enabled?: boolean }).enabled)
            .map(([name]) => name);

        const { proactive } = cfg;

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
                    heartbeats: proactive.heartbeats.enabled,
                    scheduler: proactive.scheduler.enabled,
                    healthMonitor: proactive.healthMonitor.enabled,
                },
                timezone: cfg.timezone,
            },
            'config loaded',
        );
    }

    /** Deprecated no-op; structured output is enforced inside the React planner. */
    setStructuredOutputModel(_model: BaseChatModel): void {
        // See ProactiveDecisionSchema in proactive/types.ts.
    }

    setAgentHandler(handler: AgentHandler): void {
        this.agentHandler = handler;

        // Wire /new session-facade for force-rotating sessions and
        // /skills propose for manual skill capture from the current session.
        if (handler.forceNewSession) {
            const h = handler as typeof handler & {
                proposeSkillFromCurrentSession?: (rawKey: string) => Promise<{
                    proposed: boolean; reason?: string; name?: string; description?: string;
                    when_to_use?: string; body?: string; confidence?: number;
                    autoActivated?: boolean; writtenPath?: string;
                }>;
            };
            setSessionFacade({
                forceNewSession: (rawKey) => handler.forceNewSession!(rawKey),
                ...(h.proposeSkillFromCurrentSession
                    ? { proposeSkillFromCurrentSession: (rawKey: string) => h.proposeSkillFromCurrentSession!(rawKey) }
                    : {}),
            });
        }

        // Wire /plan cancel facade — clears the thread's plan scratchpad.
        if (handler.cancelPlan) {
            setPlanFacade({
                cancel: (rawKey) => handler.cancelPlan!(rawKey),
            });
        }

        // Wire /compact facade for session history compaction.
        if (handler.compactSession) {
            setCompactFacade({
                compact: (rawKey) => handler.compactSession!(rawKey),
            });
        }

        // Wire /mcp facade for manual MCP loader pulls after credential provisioning.
        if (handler.listMcpServers && handler.reloadMcp) {
            setMcpFacade({
                listServers: () => handler.listMcpServers!(),
                reload: (opts) => handler.reloadMcp!(opts),
            });
        }

        if (handler.setGoalContinuationCallback) {
            handler.setGoalContinuationCallback(({ threadId, channelName, peerId, prompt }) => {
                const channel = this.getChannel(channelName);
                if (!channel || !this.router) {
                    this.log.warn(
                        { threadId, channelName, peerId, hasChannel: !!channel, hasRouter: !!this.router },
                        'goal continuation dropped — channel or router unavailable',
                    );
                    return;
                }
                const message: Message = {
                    id: `goal-cont-${Date.now()}`,
                    channelName,
                    peer: { id: peerId, type: 'user', name: peerId },
                    sender: { id: 'goal-loop', name: 'goal-loop' },
                    body: prompt,
                    synthetic: true,
                    timestamp: new Date().toISOString(),
                };
                this.router.route(message, channel);
            });
        }

        if (handler.setGoalNotificationCallback) {
            handler.setGoalNotificationCallback(({ threadId, channelName, peerId, kind, message }) => {
                const channel = this.getChannel(channelName);
                if (!channel) {
                    this.log.warn(
                        { threadId, channelName, peerId, kind },
                        'goal notification dropped — channel unavailable',
                    );
                    return;
                }
                void channel
                    .send({
                        peer: { id: peerId, type: 'user', name: peerId },
                        body: message,
                    })
                    .catch((err) => {
                        this.log.warn(
                            { threadId, channelName, peerId, kind, err },
                            'goal notification send failed (non-fatal)',
                        );
                    });
            });
        }

        if (handler.getGoalManager) {
            const gm = handler.getGoalManager();
            if (gm) setGoalFacade(gm as Parameters<typeof setGoalFacade>[0]);
        }

        this.router = new MessageRouter({
            agentHandler: handler,
            coalesceDelayMs: this.cfg.gateway.coalesceDelayMs,
            gatewaySnapshotFn: () => this.getStatusSnapshot(),
            // ackReaction wiring so workers can replace the inbound 👀 with ✅/❌.
            getReactionPolicy: (channelName) => {
                const cfg = this.cfg.channels[channelName as keyof typeof this.cfg.channels];
                const ack = (cfg as { ackReaction?: { direct: boolean; group: 'always' | 'mentions' | 'never' } } | undefined)?.ackReaction;
                if (!ack) return undefined;
                return { direct: ack.direct, group: ack.group };
            },
            getAckEmoji: (channelName) => {
                const cfg = this.cfg.channels[channelName as keyof typeof this.cfg.channels];
                return (cfg as { ackReaction?: { emoji: string } } | undefined)?.ackReaction?.emoji;
            },
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

    /** Extends the base snapshot with webhook-server and proactive-engine state. */
    override getStatusSnapshot() {
        const base = super.getStatusSnapshot();

        const webhook = this.cfg.webhook.enabled
            ? {
                  enabled: true,
                  port: this.webhookServer?.isRunning ? this.webhookServer.port : this.cfg.webhook.port,
                  routeCount: this.webhookServer?.routeCount ?? 0,
              }
            : { enabled: false, routeCount: 0 };

        const p = this.cfg.proactive;
        // Live schedule counts from runtime DB across heartbeat/cron/webhook.
        const schedules = this.proactiveEngine?.listSchedules() ?? [];
        const runtimeByKind = {
            heartbeat: schedules.filter((s) => s.kind === 'heartbeat' && s.enabled).length,
            cron: schedules.filter((s) => s.kind === 'cron' && s.enabled).length,
            webhook: schedules.filter((s) => s.kind === 'webhook' && s.enabled).length,
        };

        // 24h delivery funnel aggregated for compact /status rendering.
        let funnel24h:
            | { delivered: number; suppressed: number; errors: number; queued: number; retryQueue: number }
            | undefined;
        const engine = this.proactiveEngine;
        if (engine) {
            let delivered = 0;
            let suppressed = 0;
            let errors = 0;
            let queued = 0;
            for (const row of schedules) {
                const js = engine.getStateStore().getJobStateSync(row.id);
                if (!js) continue;
                delivered += js.deliveredCount ?? 0;
                suppressed += js.suppressedCount ?? 0;
                errors += js.consecutiveErrors ?? 0;
                queued += js.queuedCount ?? 0;
            }
            funnel24h = {
                delivered,
                suppressed,
                errors,
                queued,
                retryQueue: engine.getRetryQueueDepth(),
            };
        }

        const proactive = p.enabled
            ? {
                  running: this.proactiveEngine?.isRunning() ?? false,
                  heartbeats: runtimeByKind.heartbeat,
                  cronJobs: runtimeByKind.cron,
                  inboundWebhooks: runtimeByKind.webhook,
                  lastHeartbeatAt: this.proactiveEngine?.getLastHeartbeatAt(),
                  ...(funnel24h ? { funnel24h } : {}),
              }
            : { running: false, heartbeats: 0, cronJobs: 0, inboundWebhooks: 0 };

        return { ...base, webhook, proactive };
    }

    private registerChannels(cfg: FlopsyConfig): void {
        const { channels } = cfg;

        // Chat channel is always registered — it serves the local `flopsy chat` TUI
        // and is wired to the WS adapter in ManagementServer when management is enabled.
        this.chatChannel = new ChatChannel({ enabled: true, dmPolicy: 'open' });
        // Surface the main agent's model in the WS `ready` event so the TUI
        // status bar shows the actual model (no hardcoded fallback).
        this.chatChannel.getMainModel = () => {
            const main = cfg.agents.find((a) => (a.role ?? a.type) === 'main') ?? cfg.agents[0];
            return main?.model;
        };
        this.register(this.chatChannel);
        void this.chatChannel.connect();

        if (channels.whatsapp.enabled) {
            this.register(
                new WhatsAppChannel({
                    enabled: true,
                    dmPolicy: channels.whatsapp.dm.policy,
                    allowFrom: channels.whatsapp.dm.allowFrom,
                    blockedFrom: channels.whatsapp.dm.blockedFrom,
                    groupPolicy: channels.whatsapp.group.policy,
                    allowedGroups: channels.whatsapp.group.allowedGroups,
                    showThinking: channels.whatsapp.showThinking,
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
                    showThinking: channels.telegram.showThinking,
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
                    showThinking: dc.showThinking,
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
                    showThinking: channels.line.showThinking,
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
                    showThinking: channels.signal.showThinking,
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
                    showThinking: channels.imessage.showThinking,
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
                    showThinking: channels.slack.showThinking,
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
                    showThinking: channels.googlechat.showThinking,
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

    /** Handler for `GET /management/tasks`. Filters by `thread`, `status`, `limit`. */
    private handleMgmtTasks(query: URLSearchParams): Record<string, unknown> {
        const handler = this.agentHandler;
        if (!handler || typeof handler.queryAllTasks !== 'function') {
            return { tasks: [] };
        }
        const threadId = query.get('thread') ?? undefined;
        const statusRaw = query.get('status');
        const status = statusRaw
            ? (statusRaw.split(',').filter(Boolean) as ReadonlyArray<
                  'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'killed'
              >)
            : undefined;
        const limitRaw = query.get('limit');
        const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw) || 100)) : 100;

        const tasks = handler.queryAllTasks({
            ...(threadId ? { threadId } : {}),
            ...(status ? { status } : {}),
            limit,
        });
        return { tasks };
    }

    /** Tick proactive presence + close the proactive learning loop on user messages. */
    protected async onUserActivity(message: Message): Promise<void> {
        // Mark deliveries in the last 60 min as responded for response-rate analytics.
        queueMicrotask(() => {
            try {
                getSharedLearningStore().markUserResponse(
                    message.peer.id,
                    Date.now(),
                    60 * 60 * 1000,
                );
            } catch {
                /* swallow */
            }
        });
        if (!this.proactiveEngine) return;
        await this.proactiveEngine.recordUserActivity(Date.now());
    }

    protected getProactiveHealth(): Record<string, unknown> {
        const { proactive } = this.cfg;
        const cron = this.proactiveEngine?.getCronTrigger();
        const heartbeat = this.proactiveEngine?.getHeartbeat();

        const jobSource = cron?.listJobs() ?? [];
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
            },
            scheduler: {
                enabled: proactive.scheduler.enabled,
                active: !!cron,
                jobs: jobSummary,
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

        // Management HTTP server — read-only CLI query endpoint on 127.0.0.1.
        const managementEnabled = this.cfg.gateway.management?.enabled !== false;
        if (managementEnabled) {
            // Fallback +2 avoids the +1 webhook.port collision (CLI uses same fallback).
            const mgmtPort =
                this.cfg.gateway.management?.port ?? this.cfg.gateway.port + 2;
            const mgmtHost = this.cfg.gateway.management?.host ?? '127.0.0.1';
            // Resolve token from env, then <FLOPSY_HOME>/gateway-token; generate if missing.
            const mgmtToken = resolveOrCreateMgmtToken();
            this.mgmtServer = new ManagementServer({
                host: mgmtHost,
                port: mgmtPort,
                token: mgmtToken,
                snapshotFn: () => this.getStatusSnapshot(),
                // Lambdas dereference proactiveEngine at request time so mgmt can start first.
                scheduleHandlers: {
                    list: () =>
                        (this.proactiveEngine?.listSchedules() ?? []).map((r) => ({
                            id: r.id,
                            kind: r.kind,
                            enabled: r.enabled,
                            createdAt: r.createdAt,
                            createdByThread: r.createdByThread,
                            createdByAgent: r.createdByAgent,
                            config: safeParse(r.configJson),
                        })),
                    create: async (body) => {
                        if (!this.proactiveEngine) {
                            return { ok: false as const, error: 'proactive engine not running' };
                        }
                        return handleMgmtScheduleCreate(this.proactiveEngine, body);
                    },
                    remove: (id) => {
                        if (!this.proactiveEngine) return { ok: false, message: 'proactive engine not running' };
                        return this.proactiveEngine.removeRuntimeSchedule(id)
                            ? { ok: true, message: `deleted ${id}` }
                            : { ok: false, message: `no schedule with id "${id}"` };
                    },
                    setEnabled: (id, enabled) => {
                        if (!this.proactiveEngine) return { ok: false, message: 'proactive engine not running' };
                        return this.proactiveEngine.setRuntimeScheduleEnabled(id, enabled)
                            ? { ok: true, message: `${enabled ? 'enabled' : 'disabled'} ${id}` }
                            : { ok: false, message: `no schedule with id "${id}"` };
                    },
                    setSkills: (id, skills) => {
                        if (!this.proactiveEngine) return { ok: false, message: 'proactive engine not running' };
                        return this.proactiveEngine.setRuntimeScheduleSkills(id, skills)
                            ? { ok: true, message: `skills updated for ${id} (${skills.length} bound)` }
                            : { ok: false, message: `no schedule with id "${id}"` };
                    },
                    tick: (kind) => {
                        if (!this.proactiveEngine) return { ok: false, dispatched: [] };
                        const dispatched = this.proactiveEngine.triggerAllSchedules(kind);
                        return { ok: true, dispatched };
                    },
                    trigger: async (id) => {
                        if (!this.proactiveEngine) return { ok: false, message: 'proactive engine not running' };
                        const row = this.proactiveEngine.listSchedules().find((s) => s.id === id);
                        if (!row) return { ok: false, message: `no schedule with id "${id}"` };
                        const cfg = safeParse(row.configJson) as { name?: string };
                        // triggerHeartbeat / triggerCronJob are fire-and-forget.
                        if (row.kind === 'heartbeat') {
                            const fired = cfg.name
                                ? this.proactiveEngine.triggerHeartbeat(cfg.name)
                                : false;
                            return fired
                                ? { ok: true, message: `triggered heartbeat ${id}` }
                                : { ok: false, message: `heartbeat ${id} not registered (disabled or unknown name)` };
                        }
                        if (row.kind === 'cron') {
                            const fired = this.proactiveEngine.triggerCronJob(id);
                            return fired
                                ? { ok: true, message: `triggered cron ${id}` }
                                : { ok: false, message: `cron ${id} not registered` };
                        }
                        return { ok: false, message: `kind "${row.kind}" cannot be triggered manually` };
                    },
                },
                hooksHandlers: {
                    test: (event, payload) => {
                        const reg = getHookRegistry();
                        if (!reg) return { ok: false, matched: 0, message: 'hook registry not initialized' };
                        const before = reg.list().length;
                        reg.emit(event, payload);
                        return {
                            ok: true,
                            matched: reg.list().filter((h) =>
                                h.config.events.some((e) =>
                                    e === event || (e.endsWith('.*') && event.startsWith(e.slice(0, -1))),
                                ),
                            ).length,
                            message: `event "${event}" dispatched (${before} hooks in registry)`,
                        };
                    },
                },
                tasksFn: (query) => this.handleMgmtTasks(query),
                proactiveStatsHandlers: {
                    getStats: async (windowMs: number) =>
                        (await this.proactiveEngine?.getProactiveStats(windowMs)) ?? {
                            window: { sinceMs: Date.now(), windowMs },
                            aggregate: { delivered: 0, retryQueueDepth: 0 },
                            perSchedule: [],
                        },
                    getFires: (id: string, limit: number) =>
                        this.proactiveEngine?.getScheduleFires(id, limit) ?? [],
                },
                harnessActivityFn: (windowMs: number) =>
                    getSharedLearningStore().getHarnessActivity(windowMs),
                skillReloadFn: () => {
                    invalidateSkillCatalogs();
                    this.log.info('skill catalog invalidated via mgmt — next agent turn will re-scan');
                    return { reloaded: true };
                },
                evalRunFn: async ({ prompt, timeoutMs }: { prompt: string; timeoutMs?: number }) => {
                    const handler = this.agentHandler;
                    if (!handler?.invokeStateless) {
                        return { reply: '', durationMs: 0, error: 'agentHandler not wired or lacks invokeStateless' };
                    }
                    const threadId = `eval-${randomBytes(8).toString('hex')}`;
                    const startedAt = Date.now();
                    try {
                        const result = await handler.invokeStateless(prompt, threadId, {
                            deliveryMode: 'silent',
                            signal: AbortSignal.timeout(timeoutMs ?? 120_000),
                        });
                        const durationMs = Date.now() - startedAt;
                        return {
                            reply: result.reply ?? '',
                            durationMs,
                            ...(result.tokenUsage
                                ? { tokenUsage: { input: result.tokenUsage.input, output: result.tokenUsage.output } }
                                : {}),
                        };
                    } catch (err) {
                        return {
                            reply: '',
                            durationMs: Date.now() - startedAt,
                            error: err instanceof Error ? err.message : String(err),
                        };
                    }
                },
                dndHandlers: {
                    status: async () => (await this.proactiveEngine?.getDndStatus()) ?? { active: false },
                    setDnd: async (body) => {
                        if (!this.proactiveEngine) return { ok: false, error: 'engine not running' };
                        return this.proactiveEngine.setDnd(body.durationMs, body.reason);
                    },
                    clearDnd: async () => {
                        await this.proactiveEngine?.clearDnd();
                    },
                    setQuietHours: async (body) => {
                        if (!this.proactiveEngine) return { ok: false, error: 'engine not running' };
                        return this.proactiveEngine.setQuietHoursUntil(body.untilMs);
                    },
                },
                chatHandler: this.chatChannel
                    ? new ChatHandler(this.chatChannel, { token: mgmtToken })
                    : undefined,
            });
            try {
                await this.mgmtServer.start();
            } catch (err) {
                this.log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    'management server failed to start — CLI live queries will not work',
                );
                this.mgmtServer = null;
            }
        }

        if (this.cfg.proactive.enabled) {
            this.log.info('proactive engine starting');

            const { proactive } = this.cfg;

            const embedderCfg = this.cfg.memory?.embedder;
            let embedder: ProactiveEmbedder | undefined;
            if (this.cfg.memory?.enabled !== false && embedderCfg?.model) {
                embedder = new OllamaEmbedder(
                    embedderCfg.model,
                    {},
                    undefined,
                    embedderCfg.baseUrl,
                );
            }

            // Path resolution honors flopsy.json5 overrides (bare filenames
            // auto-resolve under state/). Defaults still produce the same
            // paths as the hardcoded form below — but a user can now write
            // `statePath: "proactive-prod.json"` and have it land under state/.
            this.proactiveEngine = new ProactiveEngine({
                statePath: resolveWorkspaceConfigPath(proactive.statePath, 'state'),
                retryQueuePath: resolveWorkspaceConfigPath(proactive.retryQueuePath, 'state'),
                dedupDbPath: resolveWorkspaceConfigPath(proactive.dedupDbPath, 'state'),
                promptBaseDir: workspace.root(),
                // Resolves activeHours / quiet-hours in user's timezone instead of UTC.
                ...(this.cfg.timezone ? { defaultTimezone: this.cfg.timezone } : {}),
                followActiveChannel: proactive.followActiveChannel === true,
                // Routes proactive messages to the user's currently active channel.
                getActivePeer: () => {
                    const live = this.getLastActivePeer();
                    if (live) return { channelName: live.channelName, peer: live.peer };
                    const ch = proactive.delivery?.channelName;
                    const pairing = getSharedPairingStore();
                    const first = (ch ? pairing.listApproved(ch) : pairing.listApproved())[0];
                    if (first) return { channelName: first.channel, peer: { id: first.senderId, type: 'user' } };
                    return null;
                },
                similarityThreshold: proactive.similarityThreshold,
                similarityWindowMs: proactive.similarityWindowMs,
                ...(embedder ? { embedder } : {}),
                healthMonitor: proactive.healthMonitor.enabled
                    ? proactive.healthMonitor
                    : undefined,
                // Reuse the peer's active session for heartbeat/cron fires when supported.
                ...(this.agentHandler?.resolveProactiveThreadId
                    ? {
                          threadIdResolver: (channelName, peer, source) =>
                              this.agentHandler!.resolveProactiveThreadId!(
                                  channelName,
                                  peer,
                                  source,
                              ),
                      }
                    : {}),
            });

            const agentHandler = this.agentHandler;
            if (!agentHandler) {
                this.log.warn('proactive engine starting without agent handler — jobs will be skipped');
            }

            await this.proactiveEngine.start(
                (name) => this.channels.get(name)?.status === 'connected',
                async (name, peer, text) => {
                    const ch = this.channels.get(name);
                    if (!ch) return undefined;
                    return ch.send({ peer, body: text });
                },
                agentHandler
                    ? buildAgentCaller(agentHandler)
                    : async (message) => {
                          this.log.warn(
                              { message: message.slice(0, 80) },
                              'no agent handler — proactive job skipped',
                          );
                          return { response: '' };
                      },
                async (threadId) => {
                    this.log.debug({ threadId }, 'proactive thread eviction (LRU-managed)');
                },
                () => this.channels,
            );

            const defaultDelivery = proactive.delivery ?? {
                channelName: '',
                peer: { id: '', type: 'user' as const },
            };

            // Initialize triggers when the subsystem toggle is on, regardless of
            // config array length — runtime schedules require triggers to exist.
            if (proactive.heartbeats.enabled) {
                await this.proactiveEngine.startHeartbeats([], defaultDelivery);
            }

            if (proactive.scheduler.enabled) {
                await this.proactiveEngine.startCronJobs([], defaultDelivery);
            }

            // Hand WebhookRouter to the engine so addRuntimeWebhook can register routes.
            if (this.webhookRouter) {
                this.proactiveEngine.setWebhookRouter(this.webhookRouter);
            }

            // Wire Schedule facade for /cron + /heartbeat slash commands.
            {
                const engine = this.proactiveEngine;
                setScheduleFacade({
                    list: (kind) => {
                        const rows = engine.listSchedules();
                        return rows
                            .filter((r) => r.kind === kind)
                            .map((r) => {
                                let cfg: Record<string, unknown> = {};
                                try {
                                    cfg = JSON.parse(r.configJson) as Record<string, unknown>;
                                } catch {
                                    /* fall through */
                                }
                                const name = (cfg['name'] as string | undefined) ?? r.id;
                                const intervalOrCron = kind === 'heartbeat'
                                    ? (cfg['interval'] as string | undefined)
                                    : (() => {
                                          const sched = cfg['schedule'] as
                                              | { kind?: string; expr?: string; everyMs?: number; atMs?: number }
                                              | undefined;
                                          if (!sched) return undefined;
                                          if (sched.expr) return sched.expr;
                                          if (sched.everyMs) return `every ${sched.everyMs}ms`;
                                          if (sched.atMs) return `once @ ${new Date(sched.atMs).toISOString()}`;
                                          return undefined;
                                      })();
                                const skills = kind === 'heartbeat'
                                    ? (cfg['skills'] as readonly string[] | undefined)
                                    : ((cfg['payload'] as Record<string, unknown> | undefined)?.['skills'] as
                                          | readonly string[]
                                          | undefined);
                                return {
                                    id: r.id,
                                    name,
                                    kind,
                                    enabled: r.enabled,
                                    intervalOrCron,
                                    skills,
                                };
                            });
                    },
                    setEnabled: (id, enabled) =>
                        engine.setRuntimeScheduleEnabled(id, enabled)
                            ? { ok: true, message: `${enabled ? 'enabled' : 'disabled'} ${id}` }
                            : { ok: false, message: `no schedule with id "${id}"` },
                    trigger: async (id) => {
                        const row = engine.listSchedules().find((s) => s.id === id);
                        if (!row) return { ok: false, message: `no schedule with id "${id}"` };
                        let cfg: { name?: string } = {};
                        try {
                            cfg = JSON.parse(row.configJson) as { name?: string };
                        } catch {
                            /* fall through */
                        }
                        if (row.kind === 'heartbeat') {
                            const fired = cfg.name ? engine.triggerHeartbeat(cfg.name) : false;
                            return fired
                                ? { ok: true, message: `triggered ${id}` }
                                : { ok: false, message: `heartbeat ${id} not registered (disabled?)` };
                        }
                        const fired = engine.triggerCronJob(id);
                        return fired
                            ? { ok: true, message: `triggered ${id}` }
                            : { ok: false, message: `cron ${id} not registered` };
                    },
                    tick: (kind) => ({ ok: true, dispatched: engine.triggerAllSchedules(kind) }),
                    remove: (id) =>
                        engine.removeRuntimeSchedule(id)
                            ? { ok: true, message: `deleted ${id}` }
                            : { ok: false, message: `no schedule with id "${id}"` },
                    setSkills: (id, skills) =>
                        engine.setRuntimeScheduleSkills(id, skills)
                            ? { ok: true, message: `skills updated (${skills.length} bound)` }
                            : { ok: false, message: `no schedule with id "${id}"` },
                    currentSkills: (id, kind) => {
                        const row = engine.listSchedules().find((s) => s.id === id);
                        if (!row) return null;
                        let cfg: Record<string, unknown> = {};
                        try {
                            cfg = JSON.parse(row.configJson) as Record<string, unknown>;
                        } catch {
                            return [];
                        }
                        const raw = kind === 'heartbeat'
                            ? cfg['skills']
                            : (cfg['payload'] as Record<string, unknown> | undefined)?.['skills'];
                        if (!Array.isArray(raw)) return [];
                        return raw.filter((v): v is string => typeof v === 'string');
                    },
                });
            }

            // Wire DND facade for /dnd slash + `flopsy dnd` CLI access.
            {
                const engine = this.proactiveEngine;
                setDndFacade({
                    setDnd: async (ms, r) => {
                        const { until, reason } = await engine.setDnd(ms, r);
                        return { active: true, reason: 'dnd', untilMs: until, ...(reason ? { label: reason } : {}) };
                    },
                    clearDnd: () => engine.clearDnd(),
                    setQuietHours: async (until) => {
                        const { until: u } = await engine.setQuietHoursUntil(until);
                        return { active: true, reason: 'quiet hours', untilMs: u };
                    },
                    getStatus: () => engine.getDndStatus(),
                });
            }

            // Startup catchup: fire up to 5 missed-tick schedules, staggered 5s apart.
            void this.proactiveEngine
                .catchupMissedFires({ maxPerRestart: 5, staggerMs: 5_000 })
                .catch((err) =>
                    this.log.warn(
                        { err: err instanceof Error ? err.message : String(err) },
                        'startup catchup threw — non-fatal',
                    ),
                );

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

        this.startConfigReloader();

        this.credentialRefresher = new CredentialRefreshScheduler();
        this.credentialRefresher.start();

        // Hooks: discover + load at the end of startup so all subsystems
        // are already up and `emitHook(...)` callsites in the proactive
        // engine + command dispatcher can fire as soon as a hook is
        // registered. Loader failures are local (one bad hook doesn't
        // block the others) and the gateway boots either way.
        try {
            const hooks = await discoverAndLoadHooks();
            const registry = new HookRegistry();
            registry.setHooks(hooks);
            setHookRegistry(registry);
            this.log.info({ count: hooks.length }, 'hook registry initialized');
            emitHook('gateway.startup', {
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.version,
                pid: process.pid,
                startedAt: new Date().toISOString(),
                channels: Array.from(this.channels.keys()),
                channelsConnected: Array.from(this.channels.keys()),
                hooksLoaded: hooks.length,
            });
            // Track when gateway started so shutdown can compute uptime.
            this.startedAtMs = Date.now();
        } catch (err) {
            this.log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'hook discovery failed — continuing without hooks',
            );
        }
    }

    /** Start flopsy.json5 watcher; hot rules apply in-process, restart rules log a warning. */
    private startConfigReloader(): void {
        const reloadCfg = (this.cfg.gateway as { reload?: { enabled?: boolean } }).reload;
        if (reloadCfg?.enabled === false) {
            this.log.info('config-reload disabled via gateway.reload.enabled=false');
            return;
        }
        const configPath = getConfigPath();
        if (!configPath) {
            this.log.warn('config-reload: no config path resolvable, skipping watcher');
            return;
        }

        const rules = this.buildReloadRules();
        this.configReloader = new ConfigReloader(this.cfg, {
            configPath,
            rules,
            onApplied: (next) => {
                this.cfg = next;
            },
        });
        this.configReloader.start();
    }

    /** Reload rule table — pulls patterns/modes/reasons from shared metadata and binds handlers. */
    private buildReloadRules(): readonly ReloadRule[] {
        const hotHandlers = new Map<string, (ctx: ReloadHandlerContext) => Promise<void>>([
            ['channels.*.enabled', (ctx) => this.handleChannelToggle(ctx)],
            ['logging.level', (ctx) => this.handleLoggingChange(ctx)],
            ['logging.pretty', (ctx) => this.handleLoggingChange(ctx)],
            ['proactive.heartbeats.heartbeats.*.enabled', (ctx) => this.handleScheduleToggle(ctx, 'heartbeat')],
            ['proactive.scheduler.jobs.*.enabled', (ctx) => this.handleScheduleToggle(ctx, 'cron')],
            ['mcp.servers.**', () => this.handleMcpConfigChange()],
        ]);
        return RELOAD_RULES_META.map((m): ReloadRule => {
            const handler = hotHandlers.get(m.pattern);
            const base: ReloadRule = { pattern: m.pattern, mode: m.mode, reason: m.reason };
            return handler ? { ...base, handler } : base;
        });
    }

    /**
     * Live-apply an MCP config change (server added/edited/toggled in
     * flopsy.json5). reloadMcp re-reads the config from disk, (re)connects
     * servers, and re-bridges tools — evicting cached threads so the new
     * surface is visible immediately, no gateway restart.
     */
    private async handleMcpConfigChange(): Promise<void> {
        if (!this.agentHandler?.reloadMcp) {
            this.log.warn('mcp config changed but reloadMcp not wired — restart to apply');
            return;
        }
        try {
            const result = await this.agentHandler.reloadMcp({ evictCachedThreads: true });
            this.log.info({ connected: result?.connected ?? [] }, 'mcp config hot-reloaded');
        } catch (err) {
            this.log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'mcp hot-reload failed — restart to apply',
            );
        }
    }

    /**
     * Apply logging.level / logging.pretty changes in-process. Pino's
     * setLogConfig flips the level on the root logger; child loggers inherit
     * automatically. Cheap, safe to call repeatedly.
     */
    private async handleLoggingChange(ctx: ReloadHandlerContext): Promise<void> {
        const newLogging = (ctx.newConfig as { logging?: { level?: string; pretty?: boolean; file?: string } }).logging ?? {};
        const opts: { level?: string; pretty?: boolean; file?: string } = {};
        if (typeof newLogging.level === 'string') opts.level = newLogging.level;
        if (typeof newLogging.pretty === 'boolean') opts.pretty = newLogging.pretty;
        if (typeof newLogging.file === 'string') opts.file = newLogging.file;
        const { setLogConfig } = await import('@flopsy/shared');
        setLogConfig(opts);
        this.log.info({ path: ctx.changedPath, level: opts.level }, 'logging config hot-applied');
    }

    /**
     * Apply per-schedule enabled toggles without engine restart. The schedule
     * MUST already exist in proactive.db (i.e. it was seeded on a previous
     * boot) — adding a brand-new schedule via config still requires restart.
     */
    private async handleScheduleToggle(
        ctx: ReloadHandlerContext,
        kind: 'heartbeat' | 'cron',
    ): Promise<void> {
        if (!this.proactiveEngine) {
            this.log.warn('proactive engine not running — cannot apply schedule toggle');
            return;
        }
        const enabled = ctx.newValue === true;
        const match = ctx.changedPath.match(/\.(\d+)\.enabled$/);
        if (!match) return;
        const idx = Number(match[1]);
        const list = kind === 'heartbeat'
            ? ((ctx.newConfig as { proactive?: { heartbeats?: { heartbeats?: Array<{ id?: string; name?: string }> } } }).proactive?.heartbeats?.heartbeats ?? [])
            : ((ctx.newConfig as { proactive?: { scheduler?: { jobs?: Array<{ id?: string; name?: string }> } } }).proactive?.scheduler?.jobs ?? []);
        const entry = list[idx];
        if (!entry) return;
        const id = entry.id ?? (kind === 'heartbeat' && entry.name ? `config-hb-${entry.name}` : null);
        if (!id) {
            this.log.warn({ idx, kind }, 'schedule toggle: could not resolve schedule id');
            return;
        }
        const ok = this.proactiveEngine.setRuntimeScheduleEnabled(id, enabled);
        if (ok) {
            this.log.info({ id, kind, enabled }, 'schedule toggle hot-applied');
        } else {
            this.log.warn({ id, kind }, 'schedule toggle: id not found in proactive.db (was it seeded?)');
        }
    }

    /** Hot handler for `channels.*.enabled` — spawns/stops one adapter, leaves others. */
    private async handleChannelToggle(ctx: ReloadHandlerContext): Promise<void> {
        const match = ctx.changedPath.match(/^channels\.([^.]+)\.enabled$/);
        if (!match) return;
        const name = match[1];
        const newEnabled = ctx.newValue === true;
        const existing = this.channels.get(name);

        if (newEnabled && !existing) {
            // Live spawn not yet implemented — restart-required fallback.
            this.log.warn(
                { channel: name },
                'channel enable: live spawn not yet implemented — run `flopsy gateway restart`',
            );
            return;
        }
        if (!newEnabled && existing) {
            this.log.info({ channel: name }, 'channel disable: disconnecting adapter');
            try {
                await existing.disconnect();
            } catch (err) {
                this.log.warn({ err, channel: name }, 'channel disconnect failed');
            }
        }
    }

    protected async onBeforeStop(): Promise<void> {
        // Runs while channels are still connected — base stop() disconnects them
        // AFTER this. Emit gateway.shutdown with the last-active peer + a bound
        // `send` so the shutdown-notice hook can warn the user before their turn
        // is interrupted. Awaited with a cap so a slow send can't stall shutdown.
        const shutdownCtx: Record<string, unknown> = {
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            pid: process.pid,
            uptimeMs: this.startedAtMs ? Date.now() - this.startedAtMs : undefined,
            stoppedAt: new Date().toISOString(),
            channels: Array.from(this.channels.keys()),
            channelsConnected: Array.from(this.channels.keys()),
        };
        try {
            const recent = getSharedLearningStore().getMostRecentPeer();
            const peer = recent ? peerFromKey(recent.peerId) : undefined;
            if (recent && peer) {
                shutdownCtx.lastPeer = { channel: recent.channel, peer };
                shutdownCtx.send = async (
                    channel: string,
                    p: { id: string; type: 'user' | 'group' | 'channel' },
                    body: string,
                ): Promise<void> => {
                    await this.channels.get(channel)?.send({ peer: p, body });
                };
            }
        } catch (err) {
            this.log.debug({ err }, 'shutdown notice: could not resolve last peer');
        }
        this.log.info(
            {
                hasLastPeer: !!shutdownCtx.lastPeer,
                hasSend: typeof shutdownCtx.send === 'function',
                lastPeer: shutdownCtx.lastPeer,
                channels: Array.from(this.channels.keys()),
            },
            'onBeforeStop: emitting gateway.shutdown notice (channels still live)',
        );
        await Promise.race([
            emitHookAwait('gateway.shutdown', shutdownCtx),
            new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]).catch((err) => this.log.warn({ err }, 'gateway.shutdown hook error (non-fatal)'));
    }

    protected async onStop(): Promise<void> {
        if (this.configReloader) {
            this.configReloader.stop();
            this.configReloader = null;
        }
        if (this.credentialRefresher) {
            this.credentialRefresher.stop();
            this.credentialRefresher = null;
        }
        if (this.proactiveEngine) {
            this.log.info('stopping proactive engine');
            await this.proactiveEngine.stop();
            this.proactiveEngine = null;
            setDndFacade(null);
            setScheduleFacade(null);
            setHookRegistry(null);
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

        if (this.mgmtServer) {
            this.log.debug('stopping management server');
            await this.mgmtServer.stop();
            this.mgmtServer = null;
        }

        await runCleanup().catch((err: unknown) => {
            this.log.warn({ err }, 'one or more cleanup handlers failed');
        });
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
        this.webhookServer!.registerRoute(channel.webhookPath, async (req, body, res, raw) => {
            if (!channel.verifyWebhook(req, raw ?? body)) {
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

        // Mark the channel as alive so the health monitor doesn't force-restart it.
        this.proactiveEngine?.recordChannelEvent(channel.name);

        await this.router.route(message, channel);
    }

    private async ackReact(message: Message): Promise<void> {
        // Synthetic/queued messages may have empty ids; reacting would 400.
        if (!message.id) return;

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

function safeParse(s: string): unknown {
    try { return JSON.parse(s); } catch { return {}; }
}

/** Coerce arbitrary input to a trimmed, deduplicated string array, or undefined. */
function sanitizeSkills(raw: unknown): readonly string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of raw) {
        if (typeof v !== 'string') continue;
        const trimmed = v.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out.length > 0 ? out : undefined;
}

const RESERVED_SCHEDULE_IDS = new Set(['tick']);

async function handleMgmtScheduleCreate(
    engine: ProactiveEngine,
    rawBody: unknown,
): Promise<{ ok: true; id: string; message: string } | { ok: false; error: string }> {
    const body = (rawBody ?? {}) as Record<string, unknown>;
    const kind = body['kind'] as string | undefined;
    const createdBy = (body['createdBy'] ?? {}) as {
        threadId?: string;
        agentName?: string;
    };

    if (kind === 'heartbeat') {
        if (typeof body['name'] !== 'string' || !body['name']) {
            return { ok: false, error: 'heartbeat requires `name`' };
        }
        if (typeof body['interval'] !== 'string' || !body['interval']) {
            return { ok: false, error: 'heartbeat requires `interval` (e.g. "30m")' };
        }
        if (!body['prompt'] && !body['promptFile']) {
            return { ok: false, error: 'heartbeat requires `prompt` or `promptFile`' };
        }
        const hbId = (body['id'] as string | undefined) ?? `runtime-hb-${body['name'] as string}`;
        // Validate id BEFORE filesystem touch — flows into copyPromptFile + DB row.
        const hbIdCheck = validatePathIdentifier(hbId, 'id');
        if (!hbIdCheck.ok) return { ok: false, error: hbIdCheck.error };
        if (RESERVED_SCHEDULE_IDS.has(hbIdCheck.value)) {
            return { ok: false, error: `id "${hbIdCheck.value}" is reserved` };
        }
        // Validate scripts before copyPromptFile so a bad path fails fast.
        const scriptCheck = validateScriptPath(body['script'], 'script');
        if (!scriptCheck.ok) return { ok: false, error: scriptCheck.error };
        const preCheckCheck = validateScriptPath(body['preCheckScript'], 'preCheckScript');
        if (!preCheckCheck.ok) return { ok: false, error: preCheckCheck.error };

        let resolvedPromptFile: string | undefined;
        if (body['promptFile'] !== undefined && body['promptFile'] !== null) {
            const pfCheck = validateExternalPromptFile(body['promptFile']);
            if (!pfCheck.ok) return { ok: false, error: pfCheck.error };
            try {
                resolvedPromptFile = await copyPromptFile(
                    pfCheck.path,
                    hbId,
                    'heartbeat',
                );
            } catch (err) {
                return {
                    ok: false,
                    error: `prompt-file copy failed: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        }
        const hb = {
            id: hbId,
            name: body['name'] as string,
            enabled: true,
            interval: body['interval'] as string,
            prompt: (body['prompt'] as string | undefined) ?? '',
            promptFile: resolvedPromptFile,
            deliveryMode: (body['deliveryMode'] as 'always' | 'conditional' | 'silent' | undefined) ?? 'always',
            oneshot: body['oneshot'] === true,
            activeHours: body['activeHours'] as { start: number; end: number } | undefined,
            delivery: body['delivery'] as Parameters<typeof engine.addRuntimeHeartbeat>[0]['delivery'],
            noAgent: body['noAgent'] === true,
            script: scriptCheck.path,
            preCheckScript: preCheckCheck.path,
            // Skill bindings resolved at fire time by the executor.
            skills: sanitizeSkills(body['skills']),
        };
        const ok = engine.addRuntimeHeartbeat(hb, createdBy);
        return ok
            ? { ok: true, id: hb.id, message: `heartbeat "${hb.name}" created` }
            : { ok: false, error: 'failed to add heartbeat (duplicate name or invalid interval)' };
    }

    if (kind === 'cron') {
        if (!body['schedule']) {
            return { ok: false, error: 'cron requires `schedule` { kind, atMs|everyMs|expr }' };
        }
        if (!body['message'] && !body['promptFile'] && !body['prompt']) {
            return { ok: false, error: 'cron requires `message` or `promptFile`' };
        }
        const id =
            (body['id'] as string | undefined) ??
            `runtime-cron-${Date.now()}-${randomBytes(4).toString('hex')}`;
        const cronIdCheck = validatePathIdentifier(id, 'id');
        if (!cronIdCheck.ok) return { ok: false, error: cronIdCheck.error };
        if (RESERVED_SCHEDULE_IDS.has(cronIdCheck.value)) {
            return { ok: false, error: `id "${cronIdCheck.value}" is reserved` };
        }
        // Validate paths first; reject early before any fs touch.
        const cronScriptCheck = validateScriptPath(body['script'], 'script');
        if (!cronScriptCheck.ok) return { ok: false, error: cronScriptCheck.error };
        const cronPreCheck = validateScriptPath(body['preCheckScript'], 'preCheckScript');
        if (!cronPreCheck.ok) return { ok: false, error: cronPreCheck.error };

        let resolvedCronPromptFile: string | undefined;
        if (body['promptFile'] !== undefined && body['promptFile'] !== null) {
            const cronPfCheck = validateExternalPromptFile(body['promptFile']);
            if (!cronPfCheck.ok) return { ok: false, error: cronPfCheck.error };
            try {
                resolvedCronPromptFile = await copyPromptFile(
                    cronPfCheck.path,
                    id,
                    'cron',
                );
            } catch (err) {
                return {
                    ok: false,
                    error: `prompt-file copy failed: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        }
        const job = {
            id,
            name: (body['name'] as string | undefined) ?? id,
            enabled: true,
            schedule: body['schedule'] as Parameters<typeof engine.addRuntimeCronJob>[0]['schedule'],
            payload: {
                message:
                    (body['message'] as string | undefined) ??
                    (body['prompt'] as string | undefined),
                promptFile: resolvedCronPromptFile,
                deliveryMode: (body['deliveryMode'] as 'always' | 'conditional' | 'silent' | undefined) ?? 'always',
                oneshot: body['oneshot'] === true,
                threadId: body['threadId'] as string | undefined,
                delivery: body['delivery'] as Parameters<typeof engine.addRuntimeCronJob>[0]['payload']['delivery'],
                noAgent: body['noAgent'] === true,
                script: cronScriptCheck.path,
                preCheckScript: cronPreCheck.path,
                skills: sanitizeSkills(body['skills']),
            },
            requires: [] as string[],
        };
        const ok = engine.addRuntimeCronJob(job, createdBy);
        return ok
            ? { ok: true, id, message: `cron job "${job.name}" created` }
            : { ok: false, error: 'failed to add cron job (engine not running?)' };
    }

    if (kind === 'webhook') {
        // Registers an HTTP route on the WebhookServer for external POSTs.
        if (typeof body['name'] !== 'string' || !body['name']) {
            return { ok: false, error: 'webhook requires `name` (also used as the id)' };
        }
        if (typeof body['path'] !== 'string' || !(body['path'] as string).startsWith('/')) {
            return { ok: false, error: 'webhook requires `path` starting with "/" (e.g. "/webhook/github")' };
        }
        if (typeof body['targetChannel'] !== 'string' || !body['targetChannel']) {
            return { ok: false, error: 'webhook requires `targetChannel` (channel name that receives the event)' };
        }
        // Default to GitHub's HMAC-SHA256 hex format when `secret` is set without `signature`.
        const githubDefaultSignature = {
            header: 'x-hub-signature-256',
            algorithm: 'sha256' as const,
            format: 'hex' as const,
            prefix: 'sha256=',
        };
        const cfg = {
            name: body['name'] as string,
            path: body['path'] as string,
            targetChannel: body['targetChannel'] as string,
            ...(typeof body['targetThread'] === 'string' && body['targetThread']
                ? { targetThread: body['targetThread'] as string }
                : {}),
            ...(typeof body['secret'] === 'string'
                ? {
                    secret: body['secret'] as string,
                    signature: (body['signature'] as Record<string, unknown> | undefined) ?? githubDefaultSignature,
                }
                : {}),
            ...(typeof body['eventTypeHeader'] === 'string'
                ? { eventTypeHeader: body['eventTypeHeader'] as string }
                : {}),
            ...(Array.isArray(body['filterActions']) && (body['filterActions'] as unknown[]).length > 0
                ? { filterActions: (body['filterActions'] as unknown[]).map(String) }
                : {}),
            ...(typeof body['deliveryMode'] === 'string' && body['deliveryMode'] !== 'always'
                ? { deliveryMode: body['deliveryMode'] as 'conditional' | 'silent' }
                : {}),
        };
        const ok = engine.addRuntimeWebhook(cfg, createdBy);
        return ok
            ? { ok: true, id: cfg.name, message: `webhook "${cfg.name}" registered at ${cfg.path}` }
            : { ok: false, error: 'failed to register webhook (server not up or duplicate path)' };
    }

    return { ok: false, error: `unknown kind "${kind ?? '(missing)'}" — expected "heartbeat" | "cron" | "webhook"` };
}
