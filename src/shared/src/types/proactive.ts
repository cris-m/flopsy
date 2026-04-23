/**
 * Minimal Peer shape — duplicated from `@flopsy/gateway` to keep `shared`
 * dependency-free of `gateway`. Structural typing means any Peer from gateway
 * satisfies this contract.
 */
export interface Peer {
    id: string;
    type: 'user' | 'group' | 'channel';
    name?: string;
}

export type CronSchedule =
    | { kind: 'at'; atMs: number }
    | { kind: 'every'; everyMs: number; anchorMs?: number }
    | { kind: 'cron'; expr: string; tz?: string };

export type DeliveryMode = 'always' | 'conditional' | 'silent';

export interface DeliveryTarget {
    channelName: string;
    peer: Peer;
    fallbacks?: Array<{
        channelName: string;
        peer: Peer;
    }>;
}

export type TriggerKind = 'heartbeat' | 'cron' | 'webhook';

export interface HeartbeatDefinition {
    name: string;
    enabled: boolean;
    interval: string;
    prompt: string;
    deliveryMode: DeliveryMode;
    activeHours?: { start: number; end: number; timezone?: string };
    oneshot?: boolean;
    delivery?: DeliveryTarget;
}

export interface CronPayload {
    message?: string;
    promptFile?: string;
    delivery?: DeliveryTarget;
    threadId?: string;
    deliveryMode?: DeliveryMode;
}

export interface JobDefinition {
    id: string;
    name: string;
    description?: string;
    enabled: boolean;
    schedule: CronSchedule;
    payload: CronPayload;
    requires?: string[];
    createdAt?: number;
    updatedAt?: number;
}

export interface ExecutionJob {
    id: string;
    name: string;
    trigger: TriggerKind;
    prompt: string;
    delivery: DeliveryTarget;
    deliveryMode: DeliveryMode;
    context?: Record<string, unknown>;
    threadId?: string;
}

export interface ExecutionResult {
    action: 'delivered' | 'suppressed' | 'queued' | 'error';
    response?: string;
    error?: string;
    durationMs: number;
}

export type JobExecutor = {
    execute(job: ExecutionJob): Promise<ExecutionResult>;
};

export type PresenceManager = {
    isInActiveHours(start: number, end: number, timezone?: string): Promise<boolean>;
};

// ── State Management ────────────────────────────────────────────────────

export type ActivityWindow = 'active' | 'idle' | 'away';
export type ExplicitStatus = 'dnd' | 'busy' | 'available';

export interface UserPresence {
    lastMessageAt: number;
    activityWindow: ActivityWindow;
    explicitStatus?: ExplicitStatus;
    statusExpiry?: number;
    statusReason?: string;
    quietHoursUntil?: number;
}

export interface JobState {
    lastRunAt?: number;
    lastStatus?: 'success' | 'error';
    lastAction?: ExecutionResult['action'];
    lastError?: string;
    runCount: number;
    deliveredCount: number;
    suppressedCount: number;
    queuedCount: number;
    consecutiveErrors: number;
    nextBackoffMs?: number;
    isExecuting?: boolean;
}

export type ReportedItemType = 'emails' | 'meetings' | 'tasks' | 'news';

export interface QueuedItem {
    id: string;
    content: string;
    source: string;
    priority: number;
    createdAt: number;
    delivery: DeliveryTarget;
}

export type RetryTaskType = 'message' | 'job';

export interface RetryTask {
    id: string;
    type: RetryTaskType;
    createdAt: number;
    attempts: number;
    maxAttempts: number;
    nextRetryAt: number;
    lastError?: string;
    message?: {
        channelName: string;
        threadId: string;
        peer: Peer;
        text: string;
    };
    job?: {
        id: string;
        name: string;
        trigger: TriggerKind;
        prompt: string;
        delivery: DeliveryTarget;
        deliveryMode: DeliveryMode;
    };
}

export interface ProactiveState {
    version: number;
    presence: UserPresence;
    jobs: Record<string, JobState>;
    queue: QueuedItem[];
    reportedItems: {
        emails: string[];
        meetings: string[];
        tasks: string[];
        news: string[];
    };
    recentDeliveries: Array<{
        content: string;
        deliveredAt: number;
        source: string;
    }>;
    recentTopics: Array<{
        topic: string;
        coveredAt: number;
        source: string;
        delivered?: boolean;
    }>;
}

export const BACKOFF_SCHEDULE_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;
export const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000] as const;
export const RETRY_MAX_ATTEMPTS = 3;
