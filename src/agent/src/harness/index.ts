/**
 * Harness Core
 *
 * The learning system that makes FlopsyBot intelligent:
 * - Stores: Persistent storage for strategies, lessons, metrics
 * - Triggers: Proactive scheduling (cron, heartbeat, webhook)
 * - State: User presence, message queue, retry queue management
 * - Hooks: FlopsyGraph interceptors for context loading, signal detection, mid-turn injection
 * - Learning: Signal detection, strategy updates, skill extraction
 */

export { StrategyStore, LessonStore } from './stores';
export { CronTrigger, HeartbeatTrigger, WebhookTrigger } from './triggers';
export { StateStore, PresenceManager, QueueManager, RetryQueue } from './state';
export { HarnessInterceptor, createHarnessInterceptor } from './hooks';
export { SignalDetector } from './learning';
export { HarnessManager } from './harness-manager';
export type { HarnessInterceptorConfig } from './hooks';
export type { HarnessManagerConfig } from './harness-manager';
