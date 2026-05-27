// Re-export shared proactive types; persisted shapes (JobState, etc.) defined below.
import { z } from 'zod';
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

/**
 * Proactive decision schema; enforced in-loop via React planner's __respond__ tool.
 * Discriminator: `deliver`. true → message+category required; false → silenceReason required.
 */

/** Bounded categories — queryable + learnable. */
export const DeliverCategory = z.enum([
    'inbox_actionable',       // email/message needs a reply
    'callback_overdue',       // user committed to follow up, time passed
    'meeting_imminent',       // calendar event within trigger window
    'news_relevant',          // matches user's interests in MEMORY.md
    'task_followup',          // tracked task due / blocked
    'local_alert',            // repo/system/process state change
    'reminder_due',           // explicit user-set reminder fired
    'pattern_observed',       // recurring behavior worth surfacing
]);
export type DeliverCategoryT = z.infer<typeof DeliverCategory>;

/** Why the agent chose not to deliver — bounded for the same reason. */
export const SilenceReason = z.enum([
    'no_new_signal',          // scanned, nothing happened
    'duplicate_recent',       // would repeat what was delivered recently
    'low_confidence',         // saw signal, judged it not worth interrupting
    'user_dnd',               // quiet hours / focus mode
    'thread_already_active',  // user is mid-conversation on this topic
    'context_insufficient',   // agent couldn't gather enough to decide
    // Synthetic — set by JobExecutor when the agent returned empty (NOT agent-selectable).
    'empty_agent_response',
    'injection_blocked',
    'cooldown',
    // Synthetic — set by JobExecutor when the agent emits the `[SILENT]` sentinel
    // (see `isSilentSentinel` in pipeline/executor.ts). NOT agent-selectable.
    'silent_sentinel',
]);
export type SilenceReasonT = z.infer<typeof SilenceReason>;

/** Inline-renderable citation — channels can use this for link previews. */
export const CitationSchema = z.object({
    title: z.string().min(1).max(200),
    url: z.string().url(),
    source: z.string().max(50).optional(),
    snippet: z.string().max(300).optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

/** Permanent ID-based anti-repetition (don't re-deliver this item). */
export const ReportedIdsSchema = z.object({
    emails: z.array(z.string()).max(20).optional(),
    meetings: z.array(z.string()).max(20).optional(),
    tasks: z.array(z.string()).max(20).optional(),
    news: z.array(z.string()).max(20).optional(),
});
export type ReportedIds = z.infer<typeof ReportedIdsSchema>;

/**
 * Single source of truth for proactive output. Flat object (not discriminated union)
 * because cheaper models reliably fill flat schemas; cross-field constraints enforced
 * via .superRefine() below.
 */
const RawProactiveDecision = z.object({
    /** true = deliver `message` to user; false = stay silent. */
    deliver: z.boolean(),

    // ── Required regardless of branch ──
    /** One-sentence justification (why deliver / why silent). */
    reason: z.string().min(10).max(300),
    /** 0.0 = guessing, 1.0 = "I'd defend this in a postmortem". */
    confidence: z.number().min(0).max(1),

    // ── Used when deliver=true ──
    category: DeliverCategory.optional(),
    /** User-facing narrative — recall + action + finding in one prose string. */
    message: z.string().min(1).max(2000).optional(),
    /** Inline-renderable citations (Telegram previews, Discord embeds). */
    citations: z.array(CitationSchema).max(5).optional(),
    /** Permanent anti-repetition keys (email IDs, news URLs, etc.). */
    reportedIds: ReportedIdsSchema.optional(),

    // ── Used when deliver=false ──
    silenceReason: SilenceReason.optional(),
    /** What KIND of signal was evaluated (lets reviewer tune thresholds). */
    consideredCategory: DeliverCategory.optional(),

    // ── Audit (either branch) ──
    /** Memory / trace / reported refs that grounded the decision. */
    contextUsed: z.array(z.string()).max(20).optional(),
    /** Tool/delegation calls made during this fire. */
    actionsTaken: z.array(z.string()).max(10).optional(),
});

export const ProactiveDecisionSchema = RawProactiveDecision.superRefine((val, ctx) => {
    if (val.deliver === true) {
        if (!val.message || !val.message.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['message'],
                message: 'message is required when deliver=true',
            });
        }
        if (!val.category) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['category'],
                message: 'category is required when deliver=true',
            });
        }
    } else {
        if (!val.silenceReason) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['silenceReason'],
                message: 'silenceReason is required when deliver=false',
            });
        }
        if (val.message && val.message.trim().length > 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['message'],
                message: 'message must be omitted when deliver=false (the engine will not send anything)',
            });
        }
    }
});
export type ProactiveDecision = z.infer<typeof ProactiveDecisionSchema>;

export interface JobState {
    lastRunAt?: number;
    /** Timestamp of the most recent delivery or suppression — used for staleness pruning. */
    lastStatusAt?: number;
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
    /** Epoch ms when isExecuting was set; stale-lock guard recovers via STALE_LOCK_MS. */
    executingSinceMs?: number;
    /** Voice overlay chosen on the most recent fire; null = default voice. */
    lastChosenOverlay?: string | null;
    /** Mode slug chosen on the most recent fire (used by /status + per-mode cooldown). */
    lastChosenMode?: string | null;
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
    /** Candidate messages the agent chose NOT to send — sidecar to recentDeliveries (50-row cap). */
    recentSuppressions?: Array<{
        content: string;
        suppressedAt: number;
        source: string;
        reason?: string;
        mode?: string;
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
        /** Optional voice overlay (personalities.yaml key) for per-fire voice picks. */
        personality?: string;
        /** Schedule's deliveryMode; gates outputSchema enforcement in the team handler. */
        deliveryMode?: 'always' | 'conditional' | 'silent';
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
