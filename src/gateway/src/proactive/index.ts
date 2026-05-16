export { ProactiveEngine, type ProactiveEngineConfig, type ProactiveEmbedder } from './engine';
export { ProactiveDedupStore } from './state/dedup-store';
export { StateStore } from './state/store';
export { PresenceManager } from './state/presence';
export { RetryQueue } from './state/retry-queue';
export { ChannelRouter } from './delivery/router';
export { JobExecutor, parseConditionalResponse } from './pipeline/executor';
export { HeartbeatTrigger } from './triggers/heartbeat';
export { CronTrigger } from './triggers/cron';
export { ChannelHealthMonitor } from './health/monitor';
// New proactive decision schema (commit 2 of the structured-output rework).
// Baked into the React planner via `outputSchema` so structured output is
// guaranteed in-loop, no post-hoc reformatter needed.
export {
    ProactiveDecisionSchema,
    DeliverCategory,
    SilenceReason,
    CitationSchema,
    ReportedIdsSchema,
} from './types';
export type {
    ProactiveDecision,
    DeliverCategoryT,
    SilenceReasonT,
    Citation,
    ReportedIds,
} from './types';
export type {
    CronSchedule,
    DeliveryMode,
    DeliveryTarget,
    ConditionalResponse,
    TriggerKind,
    HeartbeatDefinition,
    CronPayload,
    JobDefinition,
    ExecutionJob,
    ExecutionResult,
    JobState,
    ActivityWindow,
    ExplicitStatus,
    UserPresence,
    RetryTask,
    ProactiveState,
    ChannelHealthConfig,
    ChannelChecker,
    ChannelSender,
    AgentCaller,
    ThreadCleaner,
    RunState,
    RunStatus,
} from './types';
