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
    id?: string;
    name: string;
    enabled: boolean;
    interval: string;
    prompt: string;
    promptFile?: string;
    deliveryMode: DeliveryMode;
    activeHours?: { start: number; end: number; timezone?: string };
    oneshot?: boolean;
    delivery?: DeliveryTarget;
    /**
     * When true, this heartbeat does NOT wake the agent. The runner just
     * executes `script` (must be set), and the stdout becomes the message
     * delivered to `delivery`. Empty stdout is treated as a silent tick
     * (no delivery, no cost). Non-zero exit emits an error alert.
     *
     * Use this for watchdog patterns — disk free, queue depth, RSS poll —
     * where running the LLM every tick is wasted spend.
     */
    noAgent?: boolean;
    /**
     * Path (relative to `<FLOPSY_HOME>/scripts/`) of the script to run.
     * Required when `noAgent` is true. Ignored otherwise unless you also
     * want pre-check semantics — for those use `preCheckScript` instead.
     */
    script?: string;
    /**
     * Optional pre-check script that runs BEFORE the agent. Path is
     * relative to `<FLOPSY_HOME>/scripts/` (paths escaping the dir are
     * refused). Two control signals from stdout:
     *
     *   - `{"wakeAgent": false}` on its own line → suppress the fire
     *     entirely (don't wake the agent, don't deliver). Sub-second.
     *   - Otherwise → stdout is prepended to the agent's prompt as a
     *     `<pre_check>` context block, then the agent runs as normal.
     *
     * Independent of `noAgent`. If both are set, `noAgent` wins (script
     * IS the job; pre-check semantics don't apply).
     */
    preCheckScript?: string;
    /**
     * Optional skills to pre-load into the agent's system prompt for THIS
     * fire. Each entry is a skill directory name under `.flopsy/content/skills/`
     * (e.g. `["git-summary", "inbox-triage"]` → loads `<skills>/git-summary/SKILL.md`
     * and `<skills>/inbox-triage/SKILL.md`).
     *
     * Skills are framed as HOW-to-do authority — read-only context blocks
     * in the system prompt, not new tools. Separates WHAT from HOW: the
     * prompt is the task, the skill is the recipe.
     *
     * Missing skills are warned + skipped (the fire still runs without them);
     * present skills are concatenated under a single `<active_skills>` section
     * by the executor before invoking the agent. Ignored when `noAgent` is true.
     */
    skills?: readonly string[];
    cooldownAfterSilences?: number;
}

export interface CronPayload {
    message?: string;
    promptFile?: string;
    delivery?: DeliveryTarget;
    threadId?: string;
    deliveryMode?: DeliveryMode;
    /** Fire exactly once then disable. For `kind:"at"` this is redundant
     * (an `at` schedule naturally fires once). For `kind:"every"` /
     * `kind:"cron"` it turns an otherwise-repeating job into a one-shot. */
    oneshot?: boolean;
    /** See HeartbeatDefinition.noAgent — same semantics for cron. Script
     * stdout becomes the delivered message; empty stdout = silent tick. */
    noAgent?: boolean;
    /** See HeartbeatDefinition.script. */
    script?: string;
    /** See HeartbeatDefinition.preCheckScript. */
    preCheckScript?: string;
    /** See HeartbeatDefinition.skills — same semantics for cron. */
    skills?: readonly string[];
    cooldownAfterSilences?: number;
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
    /** When true the executor runs `script` instead of waking the agent. */
    noAgent?: boolean;
    /** Script path (relative to FLOPSY_HOME/scripts/) for noAgent fires. */
    script?: string;
    /** Pre-check script. Independent of noAgent — see HeartbeatDefinition. */
    preCheckScript?: string;
    /**
     * Skill directory names to pre-load as authority context for THIS fire.
     * Resolved by the executor to `.flopsy/content/skills/<name>/SKILL.md`
     * before agentCaller — missing skills warn + skip. See
     * HeartbeatDefinition.skills for full semantics. Empty/undefined: no-op.
     */
    skills?: readonly string[];
    cooldownAfterSilences?: number;
    /**
     * Optional voice overlay name for this fire (matches a key in
     * personalities.yaml — e.g. "playful", "concise"). When set and the
     * agent has no session-bound personality (proactive fires never do
     * after the ephemeral-thread fix), the harness applies this overlay
     * for THIS fire only. Used by smart-pulse mode picker → mode-specific
     * voice mapping.
     */
    personality?: string;
}

export interface ExecutionResult {
    action: 'delivered' | 'suppressed' | 'queued' | 'error';
    response?: string;
    error?: string;
    durationMs: number;
}
