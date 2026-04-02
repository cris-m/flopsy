import { createLogger } from '@flopsy/shared';
import { StateStore } from './state/store';
import { PresenceManager } from './state/presence';
import { QueueManager } from './state/queue';
import { RetryQueue } from './state/retry-queue';
import { ChannelRouter } from './delivery/router';
import { JobExecutor } from './pipeline/executor';
import { HeartbeatTrigger } from './triggers/heartbeat';
import { CronTrigger } from './triggers/cron';
import { WebhookTrigger, type WebhookTriggerConfig } from './triggers/webhook';
import { ChannelHealthMonitor } from './health/monitor';
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

export interface ProactiveEngineConfig {
    statePath: string;
    retryQueuePath: string;
    webhook?: WebhookTriggerConfig;
    healthMonitor?: Partial<ChannelHealthConfig>;
}

const RETRY_LOOP_INTERVAL_MS = 60_000;

export class ProactiveEngine {
    private store: StateStore;
    private presence: PresenceManager;
    private queue: QueueManager;
    private retryQueue: RetryQueue;
    private router: ChannelRouter | null = null;
    private executor: JobExecutor | null = null;
    private heartbeat: HeartbeatTrigger | null = null;
    private cron: CronTrigger | null = null;
    private webhook: WebhookTrigger | null = null;
    private healthMonitor: ChannelHealthMonitor;
    private retryTimer: ReturnType<typeof setInterval> | null = null;
    private running = false;

    constructor(config: ProactiveEngineConfig) {
        this.store = new StateStore(config.statePath);
        this.presence = new PresenceManager(this.store);
        this.queue = new QueueManager(this.store);
        this.retryQueue = new RetryQueue(config.retryQueuePath);
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
            this.presence,
            this.queue,
            this.retryQueue,
        );

        this.healthMonitor.start(getChannels);
        this.startRetryLoop();
        log.info('Proactive engine started');
    }

    private startRetryLoop(): void {
        this.retryTimer = setInterval(async () => {
            if (!this.executor) return;
            const due = await this.retryQueue.getDueRetries();
            for (const task of due) {
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
        }, RETRY_LOOP_INTERVAL_MS);
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

        this.heartbeat = new HeartbeatTrigger(this.executor, this.presence);
        await this.heartbeat.start(heartbeats, defaultDelivery);

        if (this.webhook) {
            this.webhook.setHeartbeatTrigger(this.heartbeat);
        }
    }

    async startCronJobs(jobs: JobDefinition[], defaultDelivery: DeliveryTarget): Promise<void> {
        if (!this.executor) {
            log.error('Cannot start cron: engine not started');
            return;
        }

        this.cron = new CronTrigger(this.executor);
        await this.cron.start(jobs, defaultDelivery);
    }

    async startWebhookTrigger(config: WebhookTriggerConfig): Promise<void> {
        this.webhook = new WebhookTrigger();
        await this.webhook.start(config);
        if (this.heartbeat) {
            this.webhook.setHeartbeatTrigger(this.heartbeat);
        }
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;

        if (this.retryTimer) {
            clearInterval(this.retryTimer);
            this.retryTimer = null;
        }
        this.healthMonitor.stop();
        if (this.webhook) {
            await this.webhook.stop();
            this.webhook = null;
        }
        if (this.heartbeat) {
            this.heartbeat.stop();
            this.heartbeat = null;
        }
        if (this.cron) {
            await this.cron.stop();
            this.cron = null;
        }
        this.store.stop();
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
    getQueue(): QueueManager {
        return this.queue;
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
    isRunning(): boolean {
        return this.running;
    }
}
