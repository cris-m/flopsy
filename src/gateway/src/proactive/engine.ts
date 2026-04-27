import { createLogger, deletePromptFile, resolveWorkspacePath, type PromptKind } from '@flopsy/shared';
import { Cron } from 'croner';
import { StateStore } from './state/store';
import { PresenceManager } from './state/presence';
import { RetryQueue } from './state/retry-queue';
import { HeartbeatTrigger } from './triggers/heartbeat';
import { CronTrigger } from './triggers/cron';
import { ChannelRouter } from './delivery/router';
import { JobExecutor } from './pipeline/executor';
import { ChannelHealthMonitor } from './health/monitor';
import { PromptLoader } from './prompt-loader';
import { ProactiveDedupStore } from './state/dedup-store';
import { ProactiveReaper } from './reaper';
import { parseDurationMs } from './duration';
import type {
    HeartbeatDefinition,
    JobDefinition,
    DeliveryTarget,
    ChannelChecker,
    ChannelSender,
    AgentCaller,
    ThreadCleaner,
    ChannelHealthConfig,
} from './types';
import type { Channel } from '@gateway/types';

const log = createLogger('proactive');

export interface ProactiveEmbedder {
    embed(text: string): Promise<number[]>;
}

/**
 * A raw BaseChatModel used for provider-enforced structured output in
 * conditional mode. Structurally typed so the gateway package doesn't need
 * a hard dep on flopsygraph's concrete types.
 */
export interface ProactiveStructuredModel {
    withStructuredOutput<T>(schema: unknown): unknown;
}

export interface ProactiveStatsSnapshot {
    window: { sinceMs: number; windowMs: number };
    aggregate: { delivered: number; retryQueueDepth: number };
    perSchedule: Array<{
        id: string;
        kind: 'heartbeat' | 'cron' | 'webhook';
        enabled: boolean;
        name: string;
        runCount: number;
        deliveredCount: number;
        suppressedCount: number;
        queuedCount: number;
        consecutiveErrors: number;
        lastRunAt?: number;
        lastStatus?: 'success' | 'error';
        lastAction?: string;
        lastError?: string;
        deliveredInWindow: number;
    }>;
}

export interface ProactiveEngineConfig {
    statePath: string;
    retryQueuePath: string;
    /** SQLite file for delivery history + reported-item dedup. */
    dedupDbPath: string;
    /** Base directory for resolving relative promptFile paths. Defaults to cwd. */
    promptBaseDir?: string;
    /**
     * When true, proactive messages without an explicit `delivery` route to
     * the channel+peer of the user's most-recent inbound message (via the
     * getActivePeer callback). Falls back to the static `delivery` target.
     */
    followActiveChannel?: boolean;
    /** Returns the last-active channel+peer when follow-me is on. */
    getActivePeer?: () => { channelName: string; peer: DeliveryTarget['peer'] } | null;
    /** Optional embedder — when present, cosine-similarity dedup is active. */
    embedder?: ProactiveEmbedder;
    /**
     * Optional raw chat model for structured-output reformatting of the
     * agent's free-form reply in conditional mode. When present, the engine
     * runs flopsygraph's `structuredLLM(model, schema)` as a second pass
     * and treats its output as canonical.
     */
    structuredOutputModel?: unknown;
    /**
     * Cosine-similarity threshold above which a candidate delivery is treated as
     * a duplicate. nomic-embed-text on similar-topic summaries hits ~0.88–0.95.
     * Default: 0.88.
     */
    similarityThreshold?: number;
    /** How far back to scan for similar deliveries. Default 48h. */
    similarityWindowMs?: number;
    healthMonitor?: Partial<ChannelHealthConfig>;
    /**
     * Optional callback that resolves the effective threadId for a proactive
     * fire targeting a known peer, using the peer+session model. When provided,
     * heartbeat/cron fires reuse the peer's active session instead of creating
     * an ephemeral `proactive:<jobId>:<timestamp>` thread.
     *
     * Supplied by the gateway from `agentHandler.resolveProactiveThreadId`.
     */
    threadIdResolver?: (
        channelName: string,
        peer: { id: string; type: 'user' | 'group' | 'channel' },
        source: 'heartbeat' | 'cron',
    ) => string | undefined;
}

const RETRY_LOOP_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DELIVERY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const REPORTED_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export class ProactiveEngine {
    private store: StateStore;
    private dedupStore: ProactiveDedupStore;
    private presence: PresenceManager;
    private retryQueue: RetryQueue;
    private promptLoader: PromptLoader;
    private promptBaseDir: string;
    private embedder?: ProactiveEmbedder;
    private structuredOutputModel?: unknown;
    private similarityThreshold: number;
    private similarityWindowMs: number;
    private followActiveChannel: boolean;
    private getActivePeer?: () => { channelName: string; peer: DeliveryTarget['peer'] } | null;
    private router: ChannelRouter | null = null;
    private executor: JobExecutor | null = null;
    private heartbeat: HeartbeatTrigger | null = null;
    private cron: CronTrigger | null = null;
    private defaultDelivery: DeliveryTarget | null = null;
    private healthMonitor: ChannelHealthMonitor;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private pruneTimer: ReturnType<typeof setInterval> | null = null;
    private reaper: ProactiveReaper | null = null;
    private running = false;
    private threadIdResolver?: ProactiveEngineConfig['threadIdResolver'];

    constructor(config: ProactiveEngineConfig) {
        this.store = new StateStore(config.statePath);
        this.dedupStore = new ProactiveDedupStore(config.dedupDbPath);
        this.presence = new PresenceManager(this.store);
        this.retryQueue = new RetryQueue(config.retryQueuePath);
        this.promptBaseDir = config.promptBaseDir ?? resolveWorkspacePath();
        this.promptLoader = new PromptLoader(this.promptBaseDir);
        if (config.embedder) this.embedder = config.embedder;
        if (config.structuredOutputModel) this.structuredOutputModel = config.structuredOutputModel;
        this.similarityThreshold = config.similarityThreshold ?? 0.88;
        this.similarityWindowMs = config.similarityWindowMs ?? 48 * 60 * 60 * 1000;
        this.followActiveChannel = config.followActiveChannel ?? false;
        if (config.getActivePeer) this.getActivePeer = config.getActivePeer;
        if (config.threadIdResolver) this.threadIdResolver = config.threadIdResolver;
        this.healthMonitor = new ChannelHealthMonitor(config.healthMonitor);
    }

    async start(
        channelChecker: ChannelChecker,
        channelSender: ChannelSender,
        agentCaller: AgentCaller,
        threadCleaner: ThreadCleaner,
        getChannels: () => ReadonlyMap<string, Channel>,
    ): Promise<void> {
        if (this.running) return;
        this.running = true;

        this.router = new ChannelRouter(channelChecker, channelSender);

        await this.retryQueue.load();

        this.executor = new JobExecutor(
            agentCaller,
            threadCleaner,
            this.router,
            this.store,
            this.dedupStore,
            this.presence,
            this.retryQueue,
            {
                ...(this.embedder ? { embedder: this.embedder } : {}),
                ...(this.structuredOutputModel
                    ? { structuredOutputModel: this.structuredOutputModel }
                    : {}),
                similarityThreshold: this.similarityThreshold,
                similarityWindowMs: this.similarityWindowMs,
            },
        );

        this.healthMonitor.start(getChannels);
        this.startRetryLoop();
        this.startPruneLoop();

        // Sweep ephemeral `proactive:<jobId>:<timestamp>` checkpoint threads
        // every 5 min, retention 24h. Without this, per-fire cleanup misses
        // accumulate over weeks (the original 160 MB checkpoints.db was
        // partly orphans from this path).
        this.reaper = new ProactiveReaper();
        this.reaper.start();
        log.info(
            {
                embedderEnabled: !!this.embedder,
                structuredOutputEnabled: !!this.structuredOutputModel,
                similarityThreshold: this.similarityThreshold,
                similarityWindowMs: this.similarityWindowMs,
            },
            'Proactive engine started',
        );
    }

    private startPruneLoop(): void {
        const prune = () =>
            this.dedupStore.prune(DELIVERY_RETENTION_MS, REPORTED_RETENTION_MS);
        prune();
        this.pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
        this.pruneTimer.unref();
    }

    private startRetryLoop(): void {
        // Use setTimeout + reschedule-after-completion instead of setInterval
        // with an async callback, otherwise a slow retry tick overlaps with
        // the next tick and the same due task gets retried 2-3x in parallel
        // — the user receives duplicate notifications.
        const tick = async (): Promise<void> => {
            if (!this.running) return;
            try {
                if (this.executor) {
                    const due = await this.retryQueue.getDueRetries();
                    for (const task of due) {
                        if (!this.running) return;
                        if (task.type !== 'job' || !task.job) continue;
                        log.debug({ taskId: task.id, jobId: task.job.id }, 'retrying failed delivery');
                        const job: import('./types').ExecutionJob = {
                            id: task.job.id,
                            name: task.job.name,
                            trigger: task.job.trigger,
                            prompt: task.job.prompt,
                            delivery: task.job.delivery,
                            deliveryMode: task.job.deliveryMode,
                        };
                        const success = await this.executor
                            .execute(job)
                            .then((r) => r.action === 'delivered')
                            .catch(() => false);
                        await this.retryQueue.recordAttempt(task.id, success);
                    }
                }
            } catch (err) {
                log.error({ err }, 'retry loop tick failed');
            } finally {
                if (this.running) {
                    this.retryTimer = setTimeout(tick, RETRY_LOOP_INTERVAL_MS);
                    this.retryTimer.unref();
                }
            }
        };
        this.retryTimer = setTimeout(tick, RETRY_LOOP_INTERVAL_MS);
        this.retryTimer.unref();
    }

    async startHeartbeats(
        heartbeats: HeartbeatDefinition[],
        defaultDelivery: DeliveryTarget,
    ): Promise<void> {
        if (!this.executor) {
            log.error('Cannot start heartbeats: engine not started');
            return;
        }
        this.defaultDelivery = defaultDelivery;
        this.heartbeat = new HeartbeatTrigger(
            this.executor,
            this.presence,
            this.store,
            this.promptLoader,
        );
        this.heartbeat.resolveDelivery = (o) => this.resolveDelivery(o);
        if (this.threadIdResolver) {
            this.heartbeat.threadIdResolver = this.threadIdResolver;
        }

        // Seed-from-config on first boot: if flopsy.json5 has heartbeats but
        // proactive.db doesn't, import them once and set the seed marker.
        // After that, flopsy.json5 is advisory — edits go via
        // `flopsy schedule` CLI or the manage_schedule agent tool.
        this.seedSchedulesFromConfigIfNeeded({ heartbeats });

        const all = this.loadRuntimeHeartbeats();
        await this.heartbeat.start(all, defaultDelivery);

        // Drain any heartbeat additions that arrived before this startup
        // path completed (e.g. from catchupMissedFires racing the boot).
        this.flushPendingRegistrations('heartbeat');
    }

    async startCronJobs(jobs: JobDefinition[], defaultDelivery: DeliveryTarget): Promise<void> {
        if (!this.executor) {
            log.error('Cannot start cron: engine not started');
            return;
        }
        this.defaultDelivery = defaultDelivery;
        this.cron = new CronTrigger(this.executor, this.store, this.promptLoader);
        this.cron.resolveDelivery = (o) => this.resolveDelivery(o);
        if (this.threadIdResolver) {
            this.cron.threadIdResolver = this.threadIdResolver;
        }
        // Let the trigger drop DB rows when one-shots complete — otherwise
        // `flopsy cron list` accumulates phantom entries from fired oneshots.
        this.cron.deleteRuntimeRow = (id) => this.dedupStore.deleteRuntimeSchedule(id);

        // Seed-from-config on first boot (symmetric with startHeartbeats).
        this.seedSchedulesFromConfigIfNeeded({ jobs });

        const all = this.loadRuntimeCronJobs();
        await this.cron.start(all, defaultDelivery);

        // Symmetric with startHeartbeats: replay any cron adds that
        // arrived before the trigger was up.
        this.flushPendingRegistrations('cron');
    }

    /**
     * One-time import of config-defined heartbeats/cron jobs from
     * flopsy.json5 into proactive.db. Runs on first boot only — the
     * `configSeededAt` marker in proactive.json prevents re-runs so
     * subsequent edits to flopsy.json5's proactive.heartbeats / .scheduler
     * sections are advisory only. This is the Hermes/openclaw single-source
     * model — DB is authoritative post-migration.
     *
     * Idempotent within a single boot: heartbeats and cron are registered
     * via two separate engine methods (startHeartbeats / startCronJobs),
     * both of which call this. The marker is only set once both halves
     * have had a chance to import.
     */
    private seedSchedulesFromConfigIfNeeded(input: {
        heartbeats?: HeartbeatDefinition[];
        jobs?: JobDefinition[];
    }): void {
        if (this.store.getConfigSeededAt()) return;
        let imported = 0;
        if (input.heartbeats) {
            for (const hb of input.heartbeats) {
                if (!hb.enabled) continue;
                const id = hb.id ?? `config-hb-${hb.name}`;
                this.dedupStore.insertRuntimeSchedule({
                    id,
                    kind: 'heartbeat',
                    config: { ...hb, id },
                    enabled: true,
                });
                imported++;
            }
        }
        if (input.jobs) {
            for (const job of input.jobs) {
                if (!job.enabled) continue;
                this.dedupStore.insertRuntimeSchedule({
                    id: job.id,
                    kind: 'cron',
                    config: job,
                    enabled: true,
                });
                imported++;
            }
        }
        // Only write the seed marker AFTER both heartbeats + cron have had
        // a chance to import. Set it after the cron call — cron is always
        // invoked after heartbeats in the current bootstrap flow.
        if (input.jobs) {
            this.store.markConfigSeeded();
            if (imported > 0) {
                log.info(
                    { imported },
                    'Imported schedules from flopsy.json5 into proactive.db. ' +
                        'Future edits: use `flopsy schedule ...` or the manage_schedule tool. ' +
                        'The flopsy.json5 proactive.heartbeats / .scheduler sections are now advisory.',
                );
            }
        }
    }

    private loadRuntimeHeartbeats(): HeartbeatDefinition[] {
        const rows = this.dedupStore.listRuntimeSchedules().filter((r) => r.kind === 'heartbeat');
        const out: HeartbeatDefinition[] = [];
        for (const row of rows) {
            if (!row.enabled) continue;
            try {
                out.push(JSON.parse(row.configJson) as HeartbeatDefinition);
            } catch (err) {
                log.warn(
                    { id: row.id, err: err instanceof Error ? err.message : String(err) },
                    'Failed to parse runtime heartbeat config — skipping',
                );
            }
        }
        log.info({ count: out.length }, 'runtime heartbeats loaded');
        return out;
    }

    private loadRuntimeCronJobs(): JobDefinition[] {
        const rows = this.dedupStore.listRuntimeSchedules().filter((r) => r.kind === 'cron');
        const out: JobDefinition[] = [];
        for (const row of rows) {
            if (!row.enabled) continue;
            try {
                out.push(JSON.parse(row.configJson) as JobDefinition);
            } catch (err) {
                log.warn(
                    { id: row.id, err: err instanceof Error ? err.message : String(err) },
                    'Failed to parse runtime cron config — skipping',
                );
            }
        }
        log.info({ count: out.length }, 'runtime cron jobs loaded');
        return out;
    }

    /**
     * Add a heartbeat at runtime (persists + registers). Used by the
     * manage_schedule agent tool. Returns false if the engine hasn't been
     * started or the heartbeat name collides.
     */
    addRuntimeHeartbeat(
        hb: HeartbeatDefinition,
        createdBy: { threadId?: string; agentName?: string } = {},
    ): boolean {
        // Persist FIRST so the schedule survives even if live-register is
        // deferred (engine still booting). startHeartbeats picks it up via
        // loadRuntimeHeartbeats; the pending queue handles late additions.
        const id = hb.id ?? `runtime-hb-${hb.name}`;
        const withId: HeartbeatDefinition = { ...hb, id };
        this.dedupStore.insertRuntimeSchedule({
            id,
            kind: 'heartbeat',
            config: withId,
            enabled: hb.enabled !== false,
            ...(createdBy.threadId ? { createdByThread: createdBy.threadId } : {}),
            ...(createdBy.agentName ? { createdByAgent: createdBy.agentName } : {}),
        });

        if (!this.heartbeat || !this.defaultDelivery) {
            this.pendingRegistrations.push({ kind: 'heartbeat', def: withId });
            log.info(
                { id, queueDepth: this.pendingRegistrations.length },
                'addRuntimeHeartbeat queued — heartbeat trigger not yet started',
            );
            return true;
        }
        return this.heartbeat.addHeartbeat(withId, this.defaultDelivery);
    }

    /**
     * Inject the WebhookRouter so `addRuntimeWebhook` / `removeRuntimeWebhook`
     * can register and tear down HTTP routes live. Called by the gateway
     * once both the engine and the router are constructed; the router
     * reference is held for the lifetime of the engine.
     */
    setWebhookRouter(router: { addRuntimeRoute(cfg: never): boolean; removeRuntimeRoute(path: string): boolean }): void {
        // Cast through unknown to bypass the never check — we call
        // addRuntimeRoute with a concrete config object whose shape matches
        // ExternalWebhookConfig; the engine doesn't carry that type to
        // avoid importing from @gateway/core (cycle).
        this.webhookRouter = router as unknown as typeof this.webhookRouter;

        // Replay any webhook adds that arrived before the router was wired.
        this.flushPendingRegistrations('webhook');
    }
    private webhookRouter: { addRuntimeRoute(cfg: unknown): boolean; removeRuntimeRoute(path: string): boolean } | null = null;

    /**
     * Queue of runtime additions made BEFORE the corresponding subsystem was
     * up. Without this, calls during gateway boot — e.g. catchupMissedFires
     * adding a heartbeat before startHeartbeats() runs, or an HTTP API hit
     * arriving before setWebhookRouter() — get silently dropped (the old
     * behaviour produced "addRuntimeX called before startX" errors and the
     * schedule was lost).
     *
     * Now: every addRuntime* persists to DB unconditionally (so the data is
     * never lost), and if the live-register infrastructure isn't ready yet,
     * the registration is queued for replay. The start*() methods and
     * setWebhookRouter() drain their queue partition at the end of init.
     */
    private pendingRegistrations: Array<
        | { kind: 'heartbeat'; def: HeartbeatDefinition }
        | { kind: 'cron'; job: JobDefinition }
        | { kind: 'webhook'; cfg: Record<string, unknown> }
    > = [];

    private flushPendingRegistrations(kind: 'heartbeat' | 'cron' | 'webhook'): void {
        const drained = this.pendingRegistrations.filter((p) => p.kind === kind);
        this.pendingRegistrations = this.pendingRegistrations.filter((p) => p.kind !== kind);
        if (drained.length === 0) return;

        for (const item of drained) {
            try {
                if (item.kind === 'heartbeat' && this.heartbeat && this.defaultDelivery) {
                    this.heartbeat.addHeartbeat(item.def, this.defaultDelivery);
                } else if (item.kind === 'cron' && this.cron) {
                    void this.cron.addJob(item.job).catch((err) =>
                        log.warn({ jobId: item.job.id, err }, 'flushed cron add failed'),
                    );
                } else if (item.kind === 'webhook' && this.webhookRouter) {
                    this.webhookRouter.addRuntimeRoute(item.cfg);
                }
            } catch (err) {
                log.warn({ kind, err }, 'failed to flush queued registration');
            }
        }
        log.info({ kind, flushed: drained.length }, 'flushed pending runtime registrations');
    }

    /**
     * Register a webhook endpoint at runtime — persists to proactive.db
     * AND live-registers the HTTP route on the gateway's WebhookServer.
     * Returns false if the WebhookRouter isn't wired (server not up) or
     * a webhook with this id already exists.
     *
     * Unlike heartbeats/crons, webhooks don't fire on a timer — they fire
     * when an external service hits the HTTP endpoint. So they don't need
     * the executor / jobState / dedup embedding that schedules use.
     */
    addRuntimeWebhook(
        cfg: { name: string; path: string; targetChannel: string; secret?: string; eventTypeHeader?: string },
        createdBy: { threadId?: string; agentName?: string } = {},
    ): boolean {
        // Persist FIRST. setWebhookRouter drains the queue when the router
        // becomes available (the gateway wires it after the engine is built
        // but before HTTP traffic — this race can fire from catchup).
        this.dedupStore.insertRuntimeSchedule({
            id: cfg.name,
            kind: 'webhook',
            config: cfg,
            enabled: true,
            ...(createdBy.threadId ? { createdByThread: createdBy.threadId } : {}),
            ...(createdBy.agentName ? { createdByAgent: createdBy.agentName } : {}),
        });

        if (!this.webhookRouter) {
            this.pendingRegistrations.push({
                kind: 'webhook',
                cfg: cfg as unknown as Record<string, unknown>,
            });
            log.info(
                { path: cfg.path, queueDepth: this.pendingRegistrations.length },
                'addRuntimeWebhook queued — WebhookRouter not yet wired',
            );
            return true;
        }
        return this.webhookRouter.addRuntimeRoute(cfg as unknown as Record<string, unknown>);
    }

    /**
     * Add a cron job at runtime (persists + registers).
     */
    addRuntimeCronJob(
        job: JobDefinition,
        createdBy: { threadId?: string; agentName?: string } = {},
    ): boolean {
        // Persist FIRST (see addRuntimeHeartbeat note). Pre-start adds are
        // picked up by loadRuntimeCronJobs in startCronJobs; post-start adds
        // before this turn would have raced an still-initialising trigger.
        this.dedupStore.insertRuntimeSchedule({
            id: job.id,
            kind: 'cron',
            config: job,
            enabled: job.enabled !== false,
            ...(createdBy.threadId ? { createdByThread: createdBy.threadId } : {}),
            ...(createdBy.agentName ? { createdByAgent: createdBy.agentName } : {}),
        });

        if (!this.cron || !this.defaultDelivery) {
            this.pendingRegistrations.push({ kind: 'cron', job });
            log.info(
                { jobId: job.id, queueDepth: this.pendingRegistrations.length },
                'addRuntimeCronJob queued — cron trigger not yet started',
            );
            return true;
        }
        void this.cron.addJob(job).catch((err) =>
            log.error({ jobId: job.id, err }, 'Failed to add runtime cron job'),
        );
        return true;
    }

    /**
     * Delete a runtime-created schedule (persists removal + deregisters).
     * Returns false if no runtime row matched the id.
     */
    removeRuntimeSchedule(id: string): boolean {
        const row = this.dedupStore.getRuntimeSchedule(id);
        if (!row) return false;
        this.dedupStore.deleteRuntimeSchedule(id);

        // Drop orphan stats and oneshot-circuit-breaker from proactive.json
        // so the schedule disappears completely (not just from the DB).
        // Without this, `flopsy status` shows ghost entries for deleted
        // schedules forever, and a re-created schedule with the same id
        // would silently never fire (still on the do-not-fire list).
        this.store.deleteJobState(id);
        this.store.clearOneshotCompleted(id);

        // DB is the source of truth — we've already committed the delete. A
        // malformed config row makes the in-memory/HTTP cleanup best-effort.
        const cfg = safeParseConfig(row.configJson);

        const promptFile =
            (cfg['promptFile'] as string | undefined) ??
            ((cfg['payload'] as Record<string, unknown> | undefined)?.['promptFile'] as
                | string
                | undefined);
        if (promptFile && !promptFile.startsWith('/')) {
            void deletePromptFile(promptFile, row.kind as PromptKind).catch((err) =>
                log.warn({ id, err }, 'Failed to delete prompt file on schedule remove'),
            );
        }

        if (row.kind === 'heartbeat') {
            const name = cfg['name'] as string | undefined;
            if (name) this.heartbeat?.removeHeartbeat(name);
        } else if (row.kind === 'webhook') {
            const path = cfg['path'] as string | undefined;
            if (path) this.webhookRouter?.removeRuntimeRoute(path);
        } else {
            void this.cron?.removeJob(id);
        }
        return true;
    }

    /** Exposed so the schedule facade can provide the base dir for prompt file copies. */
    getPromptBaseDir(): string {
        return this.promptBaseDir;
    }

    setRuntimeScheduleEnabled(id: string, enabled: boolean): boolean {
        const row = this.dedupStore.getRuntimeSchedule(id);
        if (!row) return false;
        // Persist first so a crash between persist + hot-register can't leave
        // the in-memory state ahead of disk.
        this.dedupStore.setRuntimeScheduleEnabled(id, enabled);

        try {
            if (row.kind === 'heartbeat') {
                const hb = JSON.parse(row.configJson) as HeartbeatDefinition;
                if (enabled) {
                    if (this.heartbeat && this.defaultDelivery) {
                        this.heartbeat.addHeartbeat(hb, this.defaultDelivery);
                    }
                } else {
                    this.heartbeat?.removeHeartbeat(hb.name);
                }
            } else {
                const job = JSON.parse(row.configJson) as JobDefinition;
                if (enabled) {
                    void this.cron?.addJob(job);
                } else {
                    void this.cron?.removeJob(id);
                }
            }
        } catch (err) {
            log.warn(
                { id, err: err instanceof Error ? err.message : String(err) },
                'Hot-(re)register on setRuntimeScheduleEnabled failed — will take effect on next restart',
            );
        }
        return true;
    }

    listSchedules(): ReturnType<ProactiveDedupStore['listRuntimeSchedules']> {
        return this.dedupStore.listRuntimeSchedules();
    }

    /**
     * Aggregate stats + per-schedule JobState snapshots for observability.
     * Powers `flopsy status`, `flopsy heartbeat|cron stats`, and the
     * `/status` chat renderer's "24h" funnel line.
     *
     * `windowMs` defaults to 24 hours — callers pass 1h/7d for narrower /
     * wider windows.
     */
    async getProactiveStats(windowMs = 24 * 60 * 60 * 1000): Promise<ProactiveStatsSnapshot> {
        const sinceMs = Date.now() - windowMs;
        const deliveryCounts = this.dedupStore.countDeliveriesSince(sinceMs);
        const perSchedule: ProactiveStatsSnapshot['perSchedule'] = [];

        for (const row of this.dedupStore.listRuntimeSchedules()) {
            const cfg = safeParseConfig(row.configJson) as { name?: string };
            // Webhooks don't keep a JobState (push-driven, no fire count), so
            // we report zeros for them but still surface their enabled flag.
            const js = await this.store.getJobState(row.id);
            perSchedule.push({
                id: row.id,
                kind: row.kind,
                enabled: row.enabled,
                name: cfg.name ?? row.id,
                runCount: js.runCount ?? 0,
                deliveredCount: js.deliveredCount ?? 0,
                suppressedCount: js.suppressedCount ?? 0,
                queuedCount: js.queuedCount ?? 0,
                consecutiveErrors: js.consecutiveErrors ?? 0,
                ...(js.lastRunAt !== undefined ? { lastRunAt: js.lastRunAt } : {}),
                ...(js.lastStatus ? { lastStatus: js.lastStatus } : {}),
                ...(js.lastAction ? { lastAction: js.lastAction } : {}),
                ...(js.lastError ? { lastError: js.lastError } : {}),
                deliveredInWindow: deliveryCounts.bySource[row.id] ?? 0,
            });
        }

        return {
            window: { sinceMs, windowMs },
            aggregate: {
                delivered: deliveryCounts.total,
                retryQueueDepth: this.retryQueue.size,
            },
            perSchedule,
        };
    }

    /**
     * Recent delivery history for one schedule — newest-first, capped.
     * Backs `flopsy heartbeat|cron|webhook fires <id>`.
     */
    getScheduleFires(id: string, limit = 20): Array<{ deliveredAt: number; content: string }> {
        return this.dedupStore.listDeliveriesBySource(id, limit);
    }

    /**
     * Startup catchup — fire any heartbeats/cron jobs whose last run is far
     * enough in the past that at least one scheduled fire was missed during
     * gateway downtime. Modelled after openclaw's startup-catchup pipeline:
     * a planned, capped, staggered replay so a multi-day outage doesn't
     * flood the user with a backlog.
     *
     * Rules:
     *   - Heartbeat is overdue when `now - jobState.lastRunAt > 1.5 × interval`.
     *     The 1.5× multiplier avoids firing just because we JUST restarted
     *     and missed one tick by a few seconds.
     *   - Cron `"at"` is overdue when `atMs <= now` AND the oneshot id isn't
     *     in `completedOneshots[]`. Delegated to normal path (no catchup
     *     fire needed here; the cron trigger's "at" logic handles it on
     *     register). We still include them in the `deferred` count for
     *     transparency.
     *   - Cron `"every"` is overdue when `now - lastRunAt > 1.5 × everyMs`.
     *   - Cron `"cron"` expressions: use croner's `previousRun(now)` — if
     *     it's after lastRunAt, we missed at least one scheduled fire.
     *   - Skipped entirely: disabled rows, one-shots already completed,
     *     heartbeats/crons with no `lastRunAt` (fresh schedules — normal
     *     scheduler handles them), webhooks (push-driven, no "missed" concept).
     *
     * Guardrails:
     *   - `maxPerRestart` (default 5) — cap to prevent flooding after long
     *     downtime. Excess candidates land in the returned `deferred` count
     *     and their next regular fire will happen normally.
     *   - `staggerMs` (default 5_000) — sleep between catchup fires so they
     *     don't all hit the LLM / channel in the same tick.
     *
     * Called once from `gateway.onStart()` after triggers are registered.
     * Safe to call multiple times; becomes a no-op when no catchup needed.
     */
    async catchupMissedFires(
        opts: { maxPerRestart?: number; staggerMs?: number } = {},
    ): Promise<{ fired: number; deferred: number; totalOverdue: number }> {
        if (!this.running) {
            log.debug('catchupMissedFires: engine not running, skipping');
            return { fired: 0, deferred: 0, totalOverdue: 0 };
        }

        const maxPerRestart = Math.max(0, opts.maxPerRestart ?? 5);
        const staggerMs = Math.max(0, opts.staggerMs ?? 5_000);
        const now = Date.now();

        type Candidate = {
            kind: 'heartbeat' | 'cron';
            id: string;
            name: string;
            overdueByMs: number;
        };
        const candidates: Candidate[] = [];

        // --- Heartbeats ------------------------------------------------
        if (this.heartbeat) {
            for (const hb of this.loadRuntimeHeartbeats()) {
                if (hb.enabled === false) continue;
                if (hb.oneshot && this.store.isOneshotCompleted(hb.id ?? `heartbeat-${hb.name}`)) continue;
                const intervalMs = parseDurationMs(hb.interval);
                if (!intervalMs) continue;
                const jobState = await this.store.getJobState(hb.id ?? `heartbeat-${hb.name}`);
                if (!jobState.lastRunAt) continue; // never fired — scheduler handles first fire
                const overdueByMs = now - jobState.lastRunAt;
                if (overdueByMs > intervalMs * 1.5) {
                    candidates.push({
                        kind: 'heartbeat',
                        id: hb.id ?? `heartbeat-${hb.name}`,
                        name: hb.name,
                        overdueByMs,
                    });
                }
            }
        }

        // --- Cron jobs ------------------------------------------------
        if (this.cron) {
            for (const job of this.loadRuntimeCronJobs()) {
                if (job.enabled === false) continue;
                if (job.payload.oneshot && this.store.isOneshotCompleted(job.id)) continue;
                const jobState = await this.store.getJobState(job.id);
                if (!jobState.lastRunAt && job.schedule.kind !== 'at') continue;

                const overdueByMs = detectCronOverdue(job.schedule, jobState.lastRunAt, now);
                if (overdueByMs !== null && overdueByMs > 0) {
                    candidates.push({
                        kind: 'cron',
                        id: job.id,
                        name: job.name,
                        overdueByMs,
                    });
                }
            }
        }

        const totalOverdue = candidates.length;
        if (totalOverdue === 0) {
            log.debug('catchupMissedFires: nothing to catch up');
            return { fired: 0, deferred: 0, totalOverdue: 0 };
        }

        // Sort least-overdue first so we fire closest-to-scheduled misses first
        // (more useful than the oldest missed reminder from a week ago).
        candidates.sort((a, b) => a.overdueByMs - b.overdueByMs);
        const toFire = candidates.slice(0, maxPerRestart);
        const deferred = candidates.length - toFire.length;

        log.info(
            { candidates: candidates.map((c) => ({ id: c.id, overdueMs: c.overdueByMs })), toFire: toFire.length, deferred },
            'catchupMissedFires: planning catchup',
        );

        let fired = 0;
        for (const c of toFire) {
            try {
                const ok =
                    c.kind === 'heartbeat'
                        ? (await this.heartbeat?.triggerNow(c.name)) ?? false
                        : (await this.cron?.triggerNow(c.id)) ?? false;
                if (ok) fired++;
            } catch (err) {
                log.warn({ kind: c.kind, id: c.id, err }, 'catchupMissedFires: fire failed');
            }
            if (staggerMs > 0 && fired < toFire.length) {
                await new Promise((r) => setTimeout(r, staggerMs));
            }
        }

        log.info({ fired, deferred, totalOverdue }, 'catchupMissedFires: done');
        return { fired, deferred, totalOverdue };
    }

    /**
     * Resolves the delivery target for a schedule fire. Called by triggers at
     * fire time (not at register time) so `followActiveChannel` picks up the
     * user's current channel — not wherever they were when the schedule was
     * created. Returns null when no target can be resolved at all.
     */
    resolveDelivery(override?: DeliveryTarget): DeliveryTarget | null {
        if (override) return override;
        if (this.followActiveChannel && this.getActivePeer) {
            const live = this.getActivePeer();
            if (live) {
                return { channelName: live.channelName, peer: live.peer };
            }
        }
        return this.defaultDelivery;
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;

        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
        if (this.reaper) {
            this.reaper.stop();
            this.reaper = null;
        }
        this.healthMonitor.stop();
        if (this.heartbeat) {
            this.heartbeat.stop();
            this.heartbeat = null;
        }
        if (this.cron) {
            await this.cron.stop();
            this.cron = null;
        }
        this.store.stop();
        this.dedupStore.close();
        this.executor = null;
        this.router = null;

        log.info('Proactive engine stopped');
    }

    async triggerHeartbeat(name: string, context?: Record<string, unknown>): Promise<boolean> {
        return this.heartbeat?.triggerNow(name, context) ?? false;
    }

    async triggerCronJob(id: string): Promise<boolean> {
        return this.cron?.triggerNow(id) ?? false;
    }

    getPresence(): PresenceManager {
        return this.presence;
    }
    /** Hot-path accessor for the synchronous status snapshot builder. */
    getStateStore(): StateStore {
        return this.store;
    }
    /** Current depth of the transport-failure retry queue. */
    getRetryQueueDepth(): number {
        return this.retryQueue.size;
    }

    // ── DND API ────────────────────────────────────────────────────────
    // Thin proxies over PresenceManager — exposed on the engine so CLI +
    // slash handlers can reach them without knowing PresenceManager's
    // shape. All four return a snapshot usable in status rendering.

    async setDnd(durationMs: number, reason?: string): Promise<{
        until: number;
        reason?: string;
    }> {
        await this.presence.setExplicitStatus('dnd', durationMs, reason);
        const until = Date.now() + durationMs;
        log.info({ untilMs: until, reason }, 'DND enabled');
        return { until, ...(reason ? { reason } : {}) };
    }

    async clearDnd(): Promise<void> {
        await this.presence.clearExplicitStatus();
        log.info('DND cleared');
    }

    async setQuietHoursUntil(untilMs: number): Promise<{ until: number }> {
        await this.presence.setQuietHours(untilMs);
        log.info({ untilMs }, 'Quiet hours set');
        return { until: untilMs };
    }

    async getDndStatus(): Promise<{
        active: boolean;
        reason?: string;
        untilMs?: number;
        label?: string;
    }> {
        const presence = await this.store.getPresence();
        const now = Date.now();
        if (presence.quietHoursUntil && now < presence.quietHoursUntil) {
            return {
                active: true,
                reason: 'quiet hours',
                untilMs: presence.quietHoursUntil,
            };
        }
        if (
            presence.explicitStatus === 'dnd' &&
            presence.statusExpiry &&
            now < presence.statusExpiry
        ) {
            return {
                active: true,
                reason: 'dnd',
                untilMs: presence.statusExpiry,
                ...(presence.statusReason ? { label: presence.statusReason } : {}),
            };
        }
        return { active: false };
    }
    getHealthMonitor(): ChannelHealthMonitor {
        return this.healthMonitor;
    }
    getCronTrigger(): CronTrigger | null {
        return this.cron;
    }
    getHeartbeat(): HeartbeatTrigger | null {
        return this.heartbeat;
    }
    /** Convenience for /status — millis of the last heartbeat fire, or undefined. */
    getLastHeartbeatAt(): number | undefined {
        return this.heartbeat?.getLastFiredAt();
    }
    isRunning(): boolean {
        return this.running;
    }
}

// ── Catchup helpers (module-level — called only by catchupMissedFires) ──

/**
 * Decide whether a cron schedule missed a fire since `lastRunAt`. Returns
 * `null` when this kind of schedule has no "missed" notion (e.g. future `at`),
 * and a positive ms count otherwise. Callers compare the return against
 * their threshold — this function itself has no 1.5× guard because cron
 * expressions fire at specific instants (not every-N intervals).
 */
function detectCronOverdue(
    schedule:
        | { kind: 'at'; atMs: number }
        | { kind: 'every'; everyMs: number; anchorMs?: number }
        | { kind: 'cron'; expr: string; tz?: string },
    lastRunAt: number | undefined,
    nowMs: number,
): number | null {
    if (schedule.kind === 'at') {
        // `at` fires exactly once. If the moment passed and we've never run,
        // the trigger already handles it at register-time (picks up from
        // persistence). We never catch up `at` here — returning null prevents
        // accidental double-fire.
        return null;
    }

    if (schedule.kind === 'every') {
        if (!lastRunAt) return null;
        const overdueByMs = nowMs - lastRunAt;
        // Same 1.5× guard as heartbeats — avoid firing for a ≤1-interval miss
        // that the regular scheduler will correct on its next natural tick.
        return overdueByMs > schedule.everyMs * 1.5 ? overdueByMs : 0;
    }

    // Cron expression: ask croner whether it SHOULD have fired since lastRunAt.
    // `previousRun()` uses wall-clock now, which matches our boot-time caller.
    try {
        const cron = new Cron(schedule.expr, { timezone: schedule.tz ?? 'UTC' });
        const prevFire = cron.previousRun();
        if (!prevFire) return null;
        const prevFireMs = prevFire.getTime();
        if (!lastRunAt) return 0; // fresh job — scheduler handles first fire
        return prevFireMs > lastRunAt ? nowMs - prevFireMs : 0;
    } catch {
        return null; // malformed expression → skip rather than crash catchup
    }
}

/**
 * Parse a runtime-schedule row's configJson, returning an empty object if the
 * row is malformed. Callers pluck fields defensively since a bad row shouldn't
 * crash mutation paths that have already committed to the DB delete.
 */
function safeParseConfig(json: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(json);
        return typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}
