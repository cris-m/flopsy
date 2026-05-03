/**
 * Harness public surface.
 *
 * The harness is the LEARNING layer. Scheduling/proactive concerns live in
 * `src/gateway/src/proactive/`; the harness no longer re-exports them.
 */

export { HarnessInterceptor, toolLoopDedup, sanitizeToolCallNoise, reflectionNudge } from './hooks';
export { detectDirective } from './learning';
export { LearningStore, getSharedLearningStore, closeSharedLearningStore } from './storage';
export {
    PairingStore,
    getSharedPairingStore,
    closeSharedPairingStore,
    PAIRING_CODE_ALPHABET,
    PAIRING_CODE_LENGTH,
    PAIRING_PENDING_TTL_MS,
    PAIRING_MAX_PENDING_PER_CHANNEL,
} from './storage';
export type { PairingPending, PairingApproved, RequestCodeResult } from './storage';
export { AgentStateTracker, getAgentStateTracker } from './state';

export type { HarnessInterceptorConfig } from './hooks';
export type { AgentState, AgentStatus, ToolActivity, AgentMetrics } from './state';
export type {
    MessageRow,
    MessageSearchHit,
    SessionRow,
    ToolFailureRow,
} from './storage';
