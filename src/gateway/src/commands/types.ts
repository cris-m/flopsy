import type { Peer } from './peer-shim';
import type { GatewayStatusSnapshot as GatewaySnapshotShared } from '../types/channel';

export interface CommandContext {
    readonly args: string[];
    /** Raw trailing text — preserves whitespace. */
    readonly rawArgs: string;
    readonly channelName: string;
    readonly peer: Peer;
    readonly sender?: { readonly id: string; readonly name?: string };
    readonly threadId: string;
    readonly messageId?: string;
    readonly threadStatus?: ThreadStatus;
    readonly gatewayStatus?: GatewayStatusSnapshot;
}

export type GatewayStatusSnapshot = GatewaySnapshotShared;

export interface ThreadStatus {
    readonly threadId: string;
    readonly entryAgent: string;
    readonly activeTasks: ReadonlyArray<TaskSummary>;
    readonly recentTasks: ReadonlyArray<TaskSummary>;
    /** Today's totals; byModel sorted heaviest first. */
    readonly tokens?: {
        readonly input: number;
        readonly output: number;
        readonly calls: number;
        readonly byModel: ReadonlyArray<{
            readonly provider: string;
            readonly model: string;
            readonly input: number;
            readonly output: number;
            readonly calls: number;
        }>;
    };
    /** One entry per non-main agent. */
    readonly team?: ReadonlyArray<TeamMemberSummary>;
}

export interface TeamMemberSummary {
    readonly name: string;
    readonly type: string;
    readonly enabled: boolean;
    readonly status: 'idle' | 'running' | 'disabled';
    readonly currentTask?: {
        readonly id: string;
        readonly description: string;
        readonly runningMs: number;
    };
    /** Timestamp of most recent completion or failure. */
    readonly lastActiveAt?: number;

    readonly role?: 'main' | 'worker' | string;
    readonly domain?: string;
    readonly model?: string;
    readonly toolsets?: readonly string[];
    readonly mcpServers?: readonly string[];
    readonly sandbox?: {
        readonly enabled: boolean;
        readonly backend?: string;
        readonly language?: string;
        readonly programmaticToolCalling?: boolean;
    };
}

export interface TaskSummary {
    readonly id: string;
    readonly worker: string;
    readonly description: string;
    readonly status: 'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'killed';
    readonly startedAtMs: number;
    readonly endedAtMs?: number;
    readonly error?: string;
}

export interface CommandResult {
    readonly text: string;
    /** After sending `text`, also enqueue this into the agent message queue. */
    readonly forwardToAgent?: string;
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult | null>;

export interface CommandDef {
    /** Canonical name without the leading "/". */
    readonly name: string;
    readonly aliases?: readonly string[];
    /** Shown by /help. */
    readonly description: string;
    /** 'admin' is a placeholder; everything is 'user' for v1. */
    readonly scope?: 'user' | 'admin';
    readonly handler: CommandHandler;
}
