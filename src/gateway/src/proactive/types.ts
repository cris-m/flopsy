// Re-export shared proactive types that this file doesn't redefine locally.
// JobState, UserPresence, RetryTask, ProactiveState, and the BACKOFF/RETRY
// constants are defined below — gateway owns the persisted shape.
import type {
    Peer,
    CronSchedule,
    DeliveryMode,
    DeliveryTarget,
    TriggerKind,
    HeartbeatDefinition,
    CronPayload,
    JobDefinition,
    ExecutionJob,
    ExecutionResult,
} from '@shared/types';

export type {
    CronSchedule,
    DeliveryMode,
    DeliveryTarget,
    TriggerKind,
    HeartbeatDefinition,
    CronPayload,
    JobDefinition,
    ExecutionJob,
    ExecutionResult,
};

export interface ConditionalResponse {
    status: 'promote' | 'suppress';
    reason: string;
    content?: string;
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
    /**
     * Voice overlay name the agent's picker chose on the most recent fire.
     * Captured by the executor when the conditional-mode structured output
     * includes an `overlay` field (see executor.ts proactiveOutputSchema).
     * `null` means the picker chose default Flopsy voice; `undefined` means
     * no overlay choice was recorded (job hasn't fired, or the picker prompt
     * doesn't emit overlay metadata). Surfaced by /status for observability.
     */
    lastChosenOverlay?: string | null;
}

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
    completedOneshots?: string[];
    configSeededAt?: number;
}

export interface RunHistoryEntry {
    timestamp: number;
    jobId: string;
    jobName: string;
    trigger: TriggerKind;
    action: ExecutionResult['action'];
    durationMs: number;
    error?: string;
}

export const BACKOFF_SCHEDULE_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;

export const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000] as const;

export const RETRY_MAX_ATTEMPTS = 3;

export interface ChannelHealthConfig {
    checkIntervalMs: number;
    staleEventThresholdMs: number;
    connectGraceMs: number;
    maxRestartsPerHour: number;
    cooldownCycles: number;
}

export type ChannelChecker = (channelName: string) => boolean;

export type ChannelSender = (
    channelName: string,
    peer: Peer,
    message: string,
) => Promise<string | undefined>;

export type AgentCaller = <T = unknown>(
    message: string,
    options?: {
        threadId?: string;
        responseSchema?: { parse(data: unknown): T };
        /**
         * Optional voice overlay key (matches personalities.yaml). Plumbed
         * through to the harness configurable so the SystemPromptFn picks
         * up a per-fire overlay even when no session is open. Used by
         * proactive fires that pick a mode-specific voice (e.g. smart-pulse
         * "playful" for initiative mode, "concise" for focus mode).
         */
        personality?: string;
    },
) => Promise<{ response: string; structured?: T }>;

export type ThreadCleaner = (threadId: string) => Promise<void>;

export type RunState = 'idle' | 'thinking' | 'tool_executing' | 'streaming' | 'background';

export interface RunStatus {
    state: RunState;
    activeRuns: number;
    lastActivityAt: number;
    currentTaskId?: string;
    currentToolName?: string;
}
