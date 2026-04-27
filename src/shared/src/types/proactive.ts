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
