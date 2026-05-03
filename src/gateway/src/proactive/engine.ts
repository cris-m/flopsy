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
import { CronHealthSweeper } from './health/cron-sweeper';
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
     * Route proactive messages to the user's last-active channel+peer when
     * no explicit `delivery` is configured. Falls back to the static target.
     */
    followActiveChannel?: boolean;
    getActivePeer?: () => { channelName: string; peer: DeliveryTarget['peer'] } | null;
    /** When present, cosine-similarity dedup is active. */
    embedder?: ProactiveEmbedder;
    /** Raw chat model for structured-output reformatting in conditional mode. */
    structuredOutputModel?: unknown;
    /** nomic-embed-text on similar-topic summaries hits ~0.88–0.95. Default 0.88. */
    similarityThreshold?: number;
    /** Default 48h. */
    similarityWindowMs?: number;
    healthMonitor?: Partial<ChannelHealthConfig>;
    /**
     * Resolves the threadId for a proactive fire targeting a known peer.
     * Supplied by the gateway from `agentHandler.resolveProactiveThreadId`
     * so heartbeat/cron fires reuse the peer's active session.
     */
    threadIdResolver?: (
        channelName: string,
        peer: { id: string; type: 'user' | 'group' | 'channel' },
        source: 'heartbeat' | 'cron',
    ) => string | undefined;
}

const RETRY_LOOP_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Self-heal cadence — force-fires cron jobs whose lastRunAt is more than
// 1.5× their period behind. 5min balances OOM recovery against CPU cost.
const CRON_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
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
    private cronSweepTimer: ReturnType<typeof setInterval> | null = null;
    private cronSweeper: CronHealthSweeper | null = null;
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
        this.startCronSweepLoop();

        // Sweep ephemeral `proactive:<jobId>:<timestamp>` checkpoint rows.
        // driveOwnTimer:false shares the cron-sweep tick — one timer covers
        // both maintenance jobs.
        this.reaper = new ProactiveReaper();
        this.reaper.start({ driveOwnTimer: false });
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

    /**
     * Force-fire cron jobs whose lastRunAt is overdue (daemon outage,
     * post-fire registration, or upstream silent-swallow bugs).
     */
    private startCronSweepLoop(): void {
        this.cronSweeper = new CronHealthSweeper(
            () => this.cron,
            this.store,
        );
        // Single tick drives both cron self-healing and reaper sweeps.
        const tick = (): void => {
            void this.cronSweeper!.sweep().catch((err) => {
                log.error({ err, op: 'cron-sweep' }, 'cron sweep failed');
            });
            if (this.reaper) {
                void this.reaper.sweep().catch((err) => {
                    log.error({ err, op: 'proactive-reap' }, 'proactive reap failed');
                });
            }
        };
        // First sweep deferred by one interval to dodge startup races.
        this.cronSweepTimer = setInterval(tick, CRON_SWEEP_INTERVAL_MS);
        this.cronSweepTimer.unref();
    }

    async sweepCronHealth(): Promise<ReturnType<CronHealthSweeper['sweep']>> {
        if (!this.cronSweeper) throw new Error('engine not started');
        return this.cronSweeper.sweep();
    }

    private startRetryLoop(): void {
        // setTimeout + reschedule-after-completion (NOT setInterval) so a
        // slow tick can't overlap and double-fire retries.
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

        this.seedSchedulesFromConfigIfNeeded({ heartbeats });

        const all = this.loadRuntimeHeartbeats();
        await this.heartbeat.start(all, defaultDelivery);

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
        // Drop DB rows when one-shots complete so `flopsy cron list` doesn't
        // accumulate phantom entries.
        this.cron.deleteRuntimeRow = (id) => this.dedupStore.deleteRuntimeSchedule(id);

        this.seedSchedulesFromConfigIfNeeded({ jobs });

        const all = this.loadRuntimeCronJobs();
        await this.cron.start(all, defaultDelivery);

        this.flushPendingRegistrations('cron');
    }

    /**
     * First-boot import of config-defined schedules into proactive.db.
     * `configSeededAt` marker prevents re-runs; flopsy.json5 schedule
     * sections become advisory after seeding (DB is authoritative).
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
        // Cron is always invoked after heartbeats — write marker once both
        // halves have had a chance to import.
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

    /** Returns false if the engine isn't started or name collides. */
    addRuntimeHeartbeat(
        hb: HeartbeatDefinition,
        createdBy: { threadId?: string; agentName?: string } = {},
    ): boolean {
        // Persist first so the schedule survives boot races; the pending
        // queue handles registrations that arrive before the trigger.
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

    seedConfigWebhooks(
        configs: Array<{ name: string; path: string; targetChannel: string; secret?: string; [k: string]: unknown }>,
    ): void {
        if (!configs.length) return;
        let seeded = 0;
        for (const cfg of configs) {
            if (cfg['enabled'] === false) continue;
            this.dedupStore.insertRuntimeSchedule({
                id: cfg.name,
                kind: 'webhook',
                config: cfg,
                enabled: true,
            });
            seeded++;
        }
        if (seeded > 0) {
            log.debug({ seeded }, 'seeded config-defined webhooks into proactive.db');
        }
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

        // Restore persisted webhook routes from proactive.db. Without this,
        // every daemon restart silently loses every runtime webhook route
        // even though they're still in the DB and visible in `flopsy
        // webhook list`. Mirrors loadRuntimeHeartbeats/CronJobs which run
        // during their respective startup paths; webhook has no separate
        // start step, so we hook on the router-wire-up instead.
        const liveRouter = this.webhookRouter;
        if (liveRouter) {
            const restored = this.loadRuntimeWebhooks();
            let restoredCount = 0;
            for (const cfg of restored) {
                try {
                    if (liveRouter.addRuntimeRoute(cfg)) {
                        restoredCount += 1;
                    }
                } catch (err) {
                    log.warn(
                        { path: cfg['path'], err: err instanceof Error ? err.message : String(err) },
                        'failed to restore persisted webhook route on boot',
                    );
                }
            }
            if (restored.length > 0) {
                log.info(
                    { count: restoredCount, total: restored.length },
                    'restored persisted webhook routes',
                );
            }
        }
    }

    private loadRuntimeWebhooks(): Array<Record<string, unknown>> {
        const rows = this.dedupStore.listRuntimeSchedules().filter((r) => r.kind === 'webhook');
        const out: Array<Record<string, unknown>> = [];
        for (const row of rows) {
            if (!row.enabled) continue;
            try {
                const cfg = JSON.parse(row.configJson) as Record<string, unknown>;
                // Legacy rows stored only `secret` — retro-fill the
                // signature config so ownsSignature works on restore.
                if (typeof cfg['secret'] === 'string' && cfg['secret'] && !cfg['signature']) {
                    cfg['signature'] = {
                        header: 'x-hub-signature-256',
                        algorithm: 'sha256',
                        format: 'hex',
                        prefix: 'sha256=',
                    };
                }
                out.push(cfg);
            } catch (err) {
                log.warn(
                    { id: row.id, err: err instanceof Error ? err.message : String(err) },
                    'Failed to parse runtime webhook config — skipping',
                );
            }
        }
        return out;
    }
    private webhookRouter: { addRuntimeRoute(cfg: unknown): boolean; removeRuntimeRoute(path: string): boolean } | null = null;

    /**
     * Queue of runtime adds that arrived before their subsystem was up.
     * Every addRuntime* persists to DB unconditionally; this queue handles
     * the in-memory live-register replay once the subsystem starts.
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

    /** Persists + live-registers an HTTP route. */
    addRuntimeWebhook(
        cfg: { name: string; path: string; targetChannel: string; secret?: string; eventTypeHeader?: string; filterActions?: string[]; targetThread?: string; deliveryMode?: 'always' | 'conditional' | 'silent' },
        createdBy: { threadId?: string; agentName?: string } = {},
    ): boolean {
        // Persist first; pending queue replays after setWebhookRouter wires.
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

    addRuntimeCronJob(
        job: JobDefinition,
        createdBy: { threadId?: string; agentName?: string } = {},
    ): boolean {
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

    /** Returns false if no runtime row matched. */
    removeRuntimeSchedule(id: string): boolean {
        const row = this.dedupStore.getRuntimeSchedule(id);
        if (!row) return false;
        this.dedupStore.deleteRuntimeSchedule(id);

        // Drop stats + oneshot-circuit-breaker so a re-created id can fire.
        this.store.deleteJobState(id);
        this.store.clearOneshotCompleted(id);

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

    getPromptBaseDir(): string {
        return this.promptBaseDir;
    }

    setRuntimeScheduleEnabled(id: string, enabled: boolean): boolean {
        const row = this.dedupStore.getRuntimeSchedule(id);
        if (!row) return false;
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
     * Replace a schedule's config in place, preserving `enabled`, `created_at`,
     * and run stats. Kind cannot change (heartbeat ↔ cron requires delete+create).
     */
    replaceRuntimeSchedule(
        id: string,
        newConfig: HeartbeatDefinition | JobDefinition,
    ): boolean {
        const existing = this.dedupStore.getRuntimeSchedule(id);
        if (!existing) return false;

        this.dedupStore.updateRuntimeScheduleConfig(id, newConfig);

        try {
            if (existing.kind === 'heartbeat') {
                const oldCfg = JSON.parse(existing.configJson) as HeartbeatDefinition;
                const newCfg = newConfig as HeartbeatDefinition;
                // Heartbeats are keyed by name — always remove old first.
                this.heartbeat?.removeHeartbeat(oldCfg.name);
                if (existing.enabled && this.heartbeat && this.defaultDelivery) {
                    this.heartbeat.addHeartbeat(newCfg, this.defaultDelivery);
                }
            } else if (existing.kind === 'cron') {
                const newJob = newConfig as JobDefinition;
                if (this.cron) {
                    void this.cron.removeJob(id).then(() => {
                        if (existing.enabled) {
                            void this.cron!.addJob(newJob).catch((err) =>
                                log.warn(
                                    { id, err: err instanceof Error ? err.message : String(err) },
                                    'Hot re-register on replaceRuntimeSchedule failed — will take effect on next restart',
                                ),
                            );
                        }
                    });
                }
            } else {
                // Webhook update not supported — path/secret changes need
                // route reregistration that's better expressed as
                // delete+create.
                return false;
            }
        } catch (err) {
            log.warn(
                { id, err: err instanceof Error ? err.message : String(err) },
                'Hot reregister on replaceRuntimeSchedule failed — DB updated; takes effect on next restart',
            );
        }
        return true;
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

    /** Newest-first, capped. */
    getScheduleFires(id: string, limit = 20): Array<{ deliveredAt: number; content: string }> {
        return this.dedupStore.listDeliveriesBySource(id, limit);
    }

    /**
     * Fire heartbeats/cron jobs whose lastRunAt indicates a missed scheduled
     * fire during downtime. Capped + staggered to avoid post-outage flood.
     *
     * Overdue thresholds: heartbeat/every uses 1.5× interval to skip just-
     * restarted-and-missed-by-seconds. Cron expressions use croner's
     * `previousRun(now)`. `at` schedules are reported but delegated to the
     * trigger's own at-on-register logic.
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

        if (this.heartbeat) {
            for (const hb of this.loadRuntimeHeartbeats()) {
                if (hb.enabled === false) continue;
                if (hb.oneshot && this.store.isOneshotCompleted(hb.id ?? `heartbeat-${hb.name}`)) continue;
                const intervalMs = parseDurationMs(hb.interval);
                if (!intervalMs) continue;
                const jobState = await this.store.getJobState(hb.id ?? `heartbeat-${hb.name}`);
                if (!jobState.lastRunAt) continue;
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

        // Least-overdue first — closest-to-scheduled misses are most useful.
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

    /** Called at fire time so followActiveChannel picks up the live channel. */
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
        if (this.cronSweepTimer) {
            clearInterval(this.cronSweepTimer);
            this.cronSweepTimer = null;
        }
        this.cronSweeper = null;
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

    /** Wired from FlopsyGateway.onUserActivity. */
    async recordUserActivity(nowMs: number = Date.now()): Promise<void> {
        await this.presence.recordUserActivity(nowMs);
    }

    getPresence(): PresenceManager {
        return this.presence;
    }
    getStateStore(): StateStore {
        return this.store;
    }
    getRetryQueueDepth(): number {
        return this.retryQueue.size;
    }

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
    getLastHeartbeatAt(): number | undefined {
        return this.heartbeat?.getLastFiredAt();
    }
    isRunning(): boolean {
        return this.running;
    }
}

/**
 * Returns positive ms overdue, 0 if not overdue, or null when the schedule
 * shape has no "missed" notion (e.g. future `at`). No 1.5× guard for cron
 * expressions — they fire at specific instants, not every-N intervals.
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
        // `at` fires once at register-time from persistence; no catchup here.
        return null;
    }

    if (schedule.kind === 'every') {
        if (!lastRunAt) return null;
        const overdueByMs = nowMs - lastRunAt;
        return overdueByMs > schedule.everyMs * 1.5 ? overdueByMs : 0;
    }

    try {
        const cron = new Cron(schedule.expr, { timezone: schedule.tz ?? 'UTC' });
        const prevFire = cron.previousRun();
        if (!prevFire) return null;
        const prevFireMs = prevFire.getTime();
        if (!lastRunAt) return 0;
        return prevFireMs > lastRunAt ? nowMs - prevFireMs : 0;
    } catch {
        return null;
    }
}

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
