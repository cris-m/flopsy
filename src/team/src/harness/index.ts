/**
 * Harness public surface.
 *
 * The harness is the LEARNING layer. Scheduling/proactive concerns live in
 * `src/gateway/src/proactive/`; the harness no longer re-exports them.
 */

export { HarnessInterceptor, createHarnessInterceptor } from './hooks';
export { SignalDetector } from './learning';
export { LearningStore, getSharedLearningStore, closeSharedLearningStore } from './storage';
export { AgentStateTracker, getAgentStateTracker } from './state';

export type { HarnessInterceptorConfig } from './hooks';
export type { AgentState, AgentStatus, ToolActivity, AgentMetrics } from './state';
export type {
    SkillEffectivenessEntry,
    FactRow,
    MessageRow,
    MessageSearchHit,
} from './storage';
