import type { AgentConfig, ModelRef } from './agent';

/** A single routing candidate: a model reference with an optional cost weight. */
export interface RoutingCandidate extends ModelRef {
    costWeight?: number;
}

/** Per-tier ordered candidate lists. */
export interface RoutingTiers {
    fast: RoutingCandidate[];
    balanced: RoutingCandidate[];
    powerful: RoutingCandidate[];
}

/**
 * All model-related configuration in one place.
 *
 * - `tiers` — which models are available per tier (used by ModelRouter at construction time)
 * - `switching` — per-call overrides based on conversation state (used by modelSwitch interceptor)
 */
export interface ModelsConfig {
    /** Tier-based model routing — "which model does this agent start with?" */
    tiers?: RoutingTiers;
    /** Per-call model switching rules — "should this specific LLM call use a different model?" */
    switching?: ModelSwitchingConfig;
}

/** Config-driven model switching rules — JSON-serializable, UI-editable. */
export interface ModelSwitchingConfig {
    /** Enable/disable without removing rules. Default: true */
    enabled?: boolean;
    /** Log when a switch occurs. Default: false */
    verbose?: boolean;
    /** Ordered rules — first match wins. */
    rules: ModelSwitchingRule[];
}

/**
 * A declarative model-switch rule — JSON-serializable.
 * All specified thresholds are AND'd: every one must match for the rule to fire.
 */
export interface ModelSwitchingRule {
    /** Human-readable name shown in logs and UI. */
    name: string;
    /** Switch to this provider. */
    provider: string;
    /** Switch to this model name (must be a registered model). */
    model: string;
    /** Fire when estimated tokens exceed this value. */
    maxTokens?: number;
    /** Fire when estimated tokens are below this value. */
    minTokens?: number;
    /** Fire when the number of bound tools exceeds this value. */
    maxTools?: number;
    /** Fire when the number of bound tools is below this value. */
    minTools?: number;
}

export interface AgentAppConfig {
    version: string;
    agent: AgentConfig;
    models?: ModelsConfig;
}
