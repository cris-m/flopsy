import { loadConfig, type FlopsyConfig, workspace, copyPromptFile } from '@flopsy/shared';
import { setDndFacade } from './commands/dnd-facade';
import { setMcpFacade } from './commands/mcp-facade';
import { setPlanFacade } from './commands/plan-facade';
import { setSessionFacade } from './commands/session-facade';
import { setCompactFacade } from './commands/compact-facade';
import { runCleanup } from '@flopsy/shared';
import type { Channel, Message, WebhookChannel } from '@gateway/types';
import { isWebhookChannel } from '@gateway/types';
import { BaseGateway } from '@gateway/core/base-gateway';
import { WebhookServer } from '@gateway/core/base-webhook';
import { MessageRouter } from '@gateway/core/message-router';
import { WebhookRouter, type ExternalWebhookConfig } from '@gateway/core/webhook-router';
import type { AgentHandler } from '@gateway/types/agent';
import { ProactiveEngine, type ProactiveEmbedder } from './proactive';
import { buildAgentCaller } from './proactive/agent-bridge';
import { OllamaEmbedder, type BaseChatModel } from 'flopsygraph';
import { MgmtServer } from './mgmt/server';
import { ChatHandler } from './mgmt/chat-handler';
import { ConfigReloader, type ReloadRule, type ReloadHandlerContext } from './config-reload';
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
    private mgmtServer: MgmtServer | null = null;
    private configReloader: ConfigReloader | null = null;
    private agentHandler: AgentHandler | null = null;
    private structuredOutputModel: BaseChatModel | null = null;
    private chatChannel: ChatChannel | null = null;
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

        // Always construct the WebhookRouter when the webhook server is
        // enabled — even with an empty `webhooks: []` array. Without this,
        // runtime adds via `flopsy webhook add` (or the agent's tool) have
        // no router to register on, the engine's setWebhookRouter is
        // never called, and persisted routes from proactive.db are never
        // restored on boot. The previous gate (`webhooks.length > 0`)
        // assumed all webhooks came from config — which broke once we
        // shipped runtime registration.
        if (cfg.webhook?.enabled) {
            this.registerExternalWebhooks(cfg.proactive.webhooks);
            if (cfg.proactive.webhooks.length > 0) {
                this.log.info(
                    {
                        count: cfg.proactive.webhooks.length,
                        names: cfg.proactive.webhooks.map((w) => w.name),
                    },
                    'external webhooks registered',
                );
            } else {
                this.log.info('webhook router ready (no config-defined routes; runtime adds welcome)');
            }
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

    /**
     * Register a raw BaseChatModel used for provider-enforced structured
     * output in the proactive engine's conditional mode. The model runs a
     * second pass over the agent's free-form reply to coerce it into the
     * ProactiveOutput schema via flopsygraph's `structuredLLM`.
     *
     * Optional — when not set, proactive falls back to post-hoc JSON
     * extraction from the agent's reply (lossier, no retry).
     */
    setStructuredOutputModel(model: BaseChatModel): void {
        this.structuredOutputModel = model;
        // Propagate to the live router (and its existing workers) — the router is
        // created in setAgentHandler which runs before this call in bootstrap, so
        // workers created before this call would otherwise capture null forever.
        this.router?.setStructuredOutputModel(model);
    }

    setAgentHandler(handler: AgentHandler): void {
        this.agentHandler = handler;

        // Wire /new session-facade so the slash command can force-rotate
        // sessions without the command layer depending on the team package.
        if (handler.forceNewSession) {
            setSessionFacade({
                forceNewSession: (rawKey) => handler.forceNewSession!(rawKey),
            });
        }

        // Wire /plan cancel facade — manual escape hatch for stuck plan
        // state. cancelPlan + getPlanState are both optional on the
        // AgentHandler interface, so older handlers (tests, stubs) that
        // don't implement them cause the slash command to fall back to
        // its forwardToAgent-only behaviour.
        if (handler.cancelPlan && handler.getPlanState) {
            setPlanFacade({
                cancel: (rawKey) => handler.cancelPlan!(rawKey),
                getState: (rawKey) => handler.getPlanState!(rawKey),
            });
        }

        // Wire /compact facade — compact the peer's active session history
        // into a single summary message. Optional on AgentHandler so test
        // stubs that don't implement it cause the slash command to reply
        // with "not available" rather than throwing.
        if (handler.compactSession) {
            setCompactFacade({
                compact: (rawKey) => handler.compactSession!(rawKey),
            });
        }

        // Wire /mcp facade — manual MCP loader pull for when an OAuth
        // credential or env var was provisioned AFTER daemon boot. Both
        // methods are optional on AgentHandler, so the slash command
        // gracefully reports "MCP facade not wired" against test stubs.
        if (handler.listMcpServers && handler.reloadMcp) {
            setMcpFacade({
                listServers: () => handler.listMcpServers!(),
                reload: (opts) => handler.reloadMcp!(opts),
            });
        }

        this.router = new MessageRouter({
            agentHandler: handler,
            coalesceDelayMs: this.cfg.gateway.coalesceDelayMs,
            // The router stamps in its own `activeThreads` count; here we
            // just hand it everything the gateway uniquely knows.
            gatewaySnapshotFn: () => this.getStatusSnapshot(),
            ...(this.structuredOutputModel ? { structuredOutputModel: this.structuredOutputModel } : {}),
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

    /**
     * Extends the base snapshot with webhook-server state and proactive-engine
     * counts. Counts come from config (heartbeats/cron defined but disabled
     * are excluded); the `running` flag reflects the live engine state. The
     * fields stay optional so consumers (and the `/status` renderer) can
     * skip sections that aren't wired.
     */
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
        // Live schedule counts — runtime DB (not config). Merge across
        // heartbeat/cron/webhook so `flopsy status` shows what's ACTUALLY
        // scheduled, not just what was pre-seeded in flopsy.json5.
        const schedules = this.proactiveEngine?.listSchedules() ?? [];
        const runtimeByKind = {
            heartbeat: schedules.filter((s) => s.kind === 'heartbeat' && s.enabled).length,
            cron: schedules.filter((s) => s.kind === 'cron' && s.enabled).length,
            webhook: schedules.filter((s) => s.kind === 'webhook' && s.enabled).length,
        };

        // 24h delivery funnel — sum per-schedule JobState counters into
        // one aggregate so the compact /status can show "↓42 ✕8 !1".
        // Best-effort: if the engine isn't running, all zero.
        let funnel24h:
            | { delivered: number; suppressed: number; errors: number; queued: number; retryQueue: number }
            | undefined;
        const engine = this.proactiveEngine;
        if (engine) {
            // getProactiveStats is async — we read a cached synchronous
            // version for the snapshot. Since JobState + deliveries are in
            // SQLite + JSON which load fast, sync-ish behaviour is fine
            // for the few schedules a single user has.
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
        // and is wired to the WS adapter in MgmtServer when mgmt is enabled.
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

    /**
     * Mgmt endpoint handler for `GET /mgmt/tasks`. Query params:
     *   thread — filter to one thread
     *   status — comma-separated list (pending,running,idle,completed,failed,killed)
     *   limit  — max rows returned (defaults to 100)
     * Returns { tasks: AggregateTaskSummary[] } or { tasks: [] } when the
     * agent layer doesn't implement `queryAllTasks`.
     */
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

    /**
     * Tick the proactive presence tracker on every dedup-clean inbound user
     * message. Without this hook, the engine's `lastMessageAt` stays at 0
     * forever and every fire sees `activityWindow = 'away'` regardless of
     * how active the user is. Best-effort — failures here must never break
     * routing; the base class already wraps this call in a catch.
     */
    protected async onUserActivity(_message: Message): Promise<void> {
        if (!this.proactiveEngine) return;
        await this.proactiveEngine.recordUserActivity(Date.now());
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

        // Management HTTP server — tiny read-only endpoint so the CLI
        // can query live state without shelling out to psutil. Defaults
        // to gateway.port + 1 (e.g. 18790) on 127.0.0.1 only. Disable
        // by setting gateway.mgmt.enabled=false.
        const mgmtEnabled = this.cfg.gateway.mgmt?.enabled !== false;
        if (mgmtEnabled) {
            // Explicit gateway.mgmt.port wins; fallback +2 instead of +1
            // because +1 collides with webhook.port (also default 18790).
            // CLI mgmtUrl uses the same +2 fallback so they agree without
            // explicit config — both end up on 18791.
            const mgmtPort =
                this.cfg.gateway.mgmt?.port ?? this.cfg.gateway.port + 2;
            const mgmtHost = this.cfg.gateway.mgmt?.host ?? '127.0.0.1';
            this.mgmtServer = new MgmtServer({
                host: mgmtHost,
                port: mgmtPort,
                token: process.env['FLOPSY_MGMT_TOKEN'],
                snapshotFn: () => this.getStatusSnapshot(),
                // Schedule handlers — lambdas dereference proactiveEngine
                // at request time so the mgmt server can start BEFORE
                // the engine (and gracefully 503 when proactive is off).
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
                    ? new ChatHandler(this.chatChannel, { token: process.env['FLOPSY_MGMT_TOKEN'] })
                    : undefined,
            });
            try {
                await this.mgmtServer.start();
            } catch (err) {
                this.log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    'mgmt server failed to start — CLI live queries will not work',
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

            this.proactiveEngine = new ProactiveEngine({
                statePath: workspace.state('proactive.json'),
                retryQueuePath: workspace.state('retry-queue.json'),
                dedupDbPath: workspace.state('proactive.db'),
                promptBaseDir: workspace.root(),
                followActiveChannel: proactive.followActiveChannel === true,
                // Auto-routes proactive messages to wherever the user is
                // chatting RIGHT NOW when followActiveChannel is on. Pulled
                // live from BaseGateway.handleInbound().
                getActivePeer: () => {
                    const live = this.getLastActivePeer();
                    if (!live) return null;
                    return { channelName: live.channelName, peer: live.peer };
                },
                similarityThreshold: proactive.similarityThreshold,
                similarityWindowMs: proactive.similarityWindowMs,
                ...(embedder ? { embedder } : {}),
                ...(this.structuredOutputModel
                    ? { structuredOutputModel: this.structuredOutputModel }
                    : {}),
                healthMonitor: proactive.healthMonitor.enabled
                    ? proactive.healthMonitor
                    : undefined,
                // When the agent handler supports session resolution, heartbeats
                // and cron fires reuse the peer's active session instead of
                // creating ephemeral `proactive:<jobId>:<timestamp>` threads.
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
                    ? buildAgentCaller(agentHandler, this.structuredOutputModel)
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

            // Initialize the heartbeat/cron triggers unconditionally when the
            // subsystem toggle is on — NOT gated on config array length.
            //
            // Runtime schedules (created via `flopsy schedule add` or the
            // `manage_schedule` agent tool) live in proactive.db and are
            // registered via `addRuntimeHeartbeat` / `addRuntimeCronJob`,
            // which REQUIRE the triggers to already be initialized (they
            // check `!this.heartbeat || !this.defaultDelivery` and fail).
            //
            // The old `.length > 0` guards meant a config with no pre-defined
            // schedules (the expected post-migration state) would leave the
            // triggers null, making every runtime add return false with the
            // misleading "duplicate name or invalid interval" message from
            // manage_schedule.ts. Pass an empty array — startHeartbeats /
            // startCronJobs both handle that fine, register the trigger,
            // and runtime adds work as intended.
            if (proactive.heartbeats.enabled) {
                await this.proactiveEngine.startHeartbeats(
                    proactive.heartbeats.heartbeats,
                    defaultDelivery,
                );
            }

            if (proactive.scheduler.enabled) {
                await this.proactiveEngine.startCronJobs(proactive.scheduler.jobs, defaultDelivery);
            }

            // Give the engine a handle to WebhookRouter so `addRuntimeWebhook`
            // can register live HTTP routes. Null-safe when webhook server
            // isn't configured — runtime webhook adds then 400 gracefully.
            if (this.webhookRouter) {
                this.proactiveEngine.setWebhookRouter(this.webhookRouter);
                this.proactiveEngine.seedConfigWebhooks(this.cfg.proactive.webhooks);
            }

            // Wire DND facade so /dnd slash + `flopsy dnd` CLI can reach the
            // live PresenceManager. Module-level singleton (same pattern as
            // ScheduleFacade) — fire-and-forget cleanup on engine stop.
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

            // Startup catchup — fire at most 5 schedules whose last run is
            // far enough in the past that we missed a tick during downtime.
            // Staggered by 5s so they don't stampede the LLM; excess
            // candidates are deferred (their next regular fire handles
            // them). Non-blocking — the engine logs the outcome itself.
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
    }

    /**
     * Start the flopsy.json5 file watcher. Changes that map to a `hot`
     * rule are applied in-process; changes that map to `restart` are
     * logged with a clear warning so the user runs `flopsy gateway
     * restart` when they're ready. Disabled entirely by setting
     * `gateway.reload.enabled: false` in flopsy.json5.
     */
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

    /**
     * Rule table — each entry declares which config path(s) it covers
     * and whether changes hot-apply (in-process) or require restart.
     *
     * Initial set covers the highest-value operational cases:
     *   - `channels.<name>.enabled` — channel on/off toggles
     *
     * Everything else falls into the explicit `restart` bucket so the
     * user gets a warning. Per-subsystem hot handlers (MCP, proactive,
     * agent model switches) come in follow-up turns.
     */
    private buildReloadRules(): readonly ReloadRule[] {
        return [
            {
                pattern: 'channels.*.enabled',
                mode: 'hot',
                reason: 'channel on/off toggle',
                handler: (ctx) => this.handleChannelToggle(ctx),
            },
            // Restart-required buckets — hot handlers for these land
            // in follow-up turns. Until then, we log and let the user
            // decide when to restart.
            { pattern: 'channels.**', mode: 'restart', reason: 'channel config beyond on/off needs rebuild' },
            { pattern: 'mcp.servers.**', mode: 'restart', reason: 'MCP subprocesses need respawn' },
            { pattern: 'agents.**', mode: 'restart', reason: 'agents are built once at boot' },
            { pattern: 'memory.**', mode: 'restart', reason: 'memory store + embedder init on boot' },
            { pattern: 'proactive.**', mode: 'restart', reason: 'heartbeat/cron/webhook rewire on boot' },
            { pattern: 'webhook.**', mode: 'restart', reason: 'webhook receiver binds on boot' },
            { pattern: 'gateway.**', mode: 'restart', reason: 'gateway host/port/token are boot-only' },
        ];
    }

    /**
     * Hot handler: flip a channel's `enabled` flag. When transitioning
     * false→true we spawn + register the adapter; true→false we stop +
     * unregister. Doesn't touch other channels — uptime-preserving.
     */
    private async handleChannelToggle(ctx: ReloadHandlerContext): Promise<void> {
        const match = ctx.changedPath.match(/^channels\.([^.]+)\.enabled$/);
        if (!match) return;
        const name = match[1];
        const newEnabled = ctx.newValue === true;
        const existing = this.channels.get(name);

        if (newEnabled && !existing) {
            // Registration happens via the constructor's registerChannels
            // path — re-running that for one channel is non-trivial
            // today. For now we log + fall back to "restart required".
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

    protected async onStop(): Promise<void> {
        // Run all registered cleanup functions in parallel first (subsystems
        // that called registerCleanup() during startup — abort controllers,
        // background workers, etc.).
        await runCleanup().catch((err: unknown) => {
            this.log.warn({ err }, 'one or more cleanup handlers failed');
        });

        if (this.configReloader) {
            this.configReloader.stop();
            this.configReloader = null;
        }
        if (this.proactiveEngine) {
            this.log.info('stopping proactive engine');
            await this.proactiveEngine.stop();
            this.proactiveEngine = null;
            setDndFacade(null);
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
            this.log.debug('stopping mgmt server');
            await this.mgmtServer.stop();
            this.mgmtServer = null;
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

function safeParse(s: string): unknown {
    try { return JSON.parse(s); } catch { return {}; }
}

/**
 * Translate a loose JSON body (from the mgmt HTTP endpoint or the CLI) into
 * a ProactiveEngine.addRuntime* call. Kept tolerant — validates presence of
 * required fields but doesn't lock down the full zod schema here since the
 * engine already validates. Mirrors the shape of the manage_schedule tool.
 */
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
        // Copy the user-supplied prompt file into .flopsy/proactive/heartbeats/
        // so the schedule owns its copy. Without this, the loader tries to
        // resolve the source path against the workspace directory at fire
        // time and the file isn't there. The agent's `manage_schedule` tool
        // path already does this; the CLI/mgmt-server path was skipping it.
        let resolvedPromptFile: string | undefined;
        if (typeof body['promptFile'] === 'string' && body['promptFile']) {
            try {
                resolvedPromptFile = await copyPromptFile(
                    body['promptFile'] as string,
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
            `runtime-cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Same file-copy path as the heartbeat branch above. Same reason.
        let resolvedCronPromptFile: string | undefined;
        if (typeof body['promptFile'] === 'string' && body['promptFile']) {
            try {
                resolvedCronPromptFile = await copyPromptFile(
                    body['promptFile'] as string,
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
            },
            requires: [] as string[],
        };
        const ok = engine.addRuntimeCronJob(job, createdBy);
        return ok
            ? { ok: true, id, message: `cron job "${job.name}" created` }
            : { ok: false, error: 'failed to add cron job (engine not running?)' };
    }

    if (kind === 'webhook') {
        // Webhook creation registers an HTTP route on the gateway's
        // WebhookServer so external services (GitHub, Stripe, Zapier, etc.)
        // can POST and have the body routed into a channel worker's event
        // queue. Signature verification is optional at MVP — add `secret` +
        // `signature` fields later to enable HMAC checks.
        if (typeof body['name'] !== 'string' || !body['name']) {
            return { ok: false, error: 'webhook requires `name` (also used as the id)' };
        }
        if (typeof body['path'] !== 'string' || !(body['path'] as string).startsWith('/')) {
            return { ok: false, error: 'webhook requires `path` starting with "/" (e.g. "/webhook/github")' };
        }
        if (typeof body['targetChannel'] !== 'string' || !body['targetChannel']) {
            return { ok: false, error: 'webhook requires `targetChannel` (channel name that receives the event)' };
        }
        // When the caller provides a `secret` without a `signature` config,
        // default to GitHub's HMAC-SHA256 hex format (`sha256=<hex>` in
        // `X-Hub-Signature-256`). Without this default, the per-route
        // verifier in webhook-router.ts:152 skips signature checking
        // entirely (`if (!cfg.secret || !cfg.signature) return true`),
        // making `--secret` dead code for runtime-added webhooks.
        // Most webhook sources we care about (GitHub, GitLab, Stripe with
        // a translation, Linear, Sentry) use this exact shape; non-default
        // sources can override via the agent's `manage_schedule` tool
        // which accepts an explicit `signature` object.
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
