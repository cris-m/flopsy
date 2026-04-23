/**
 * Slash-command types — a small adaptation of Hermes's `CommandDef` + OpenClaw's
 * chain-of-responsibility handler pattern, tailored to FlopsyBot's multi-channel
 * gateway.
 *
 * A command is a message starting with "/" intercepted by the gateway BEFORE
 * any agent turn. Handlers produce a markdown reply that gets sent directly to
 * the user, bypassing the LLM. Fast, deterministic, no token cost.
 */

import type { Peer } from './peer-shim';
import type { GatewayStatusSnapshot as GatewaySnapshotShared } from '../types/channel';

/**
 * What the dispatcher hands to each handler. Enough context to render a
 * platform-agnostic reply without reaching into gateway internals.
 */
export interface CommandContext {
    /** Command arguments after the name, split on whitespace. */
    readonly args: string[];
    /** Raw trailing text after the command name (preserves whitespace). */
    readonly rawArgs: string;
    /** Platform — 'telegram', 'discord', 'whatsapp', etc. */
    readonly channelName: string;
    /** Conversation peer (user for DMs, group/channel otherwise). */
    readonly peer: Peer;
    /** Speaker (relevant for group/channel peers). */
    readonly sender?: { readonly id: string; readonly name?: string };
    /** Routing key — used to look up per-thread state via AgentHandler. */
    readonly threadId: string;
    /** Platform-native id of the message that triggered this command. */
    readonly messageId?: string;
    /**
     * Live status snapshot for this thread (if the agent layer supports it).
     * Populated by the dispatcher by calling `AgentHandler.queryStatus(threadId)`
     * before the handler runs. Will be undefined if the thread hasn't been
     * instantiated yet or the AgentHandler doesn't implement queryStatus.
     */
    readonly threadStatus?: ThreadStatus;
    /**
     * Gateway-wide snapshot — channel connection states, uptime, basic stats.
     * Populated by ChannelWorker from a closure injected at router
     * construction time. Safe for user display: contains only metadata
     * (channel names, status flags, counts), never peer ids or tokens.
     */
    readonly gatewayStatus?: GatewayStatusSnapshot;
}

/**
 * Re-export for handler imports — the canonical shape lives in
 * `types/channel.ts` so the ChannelWorkerConfig and CommandContext share it.
 */
export type GatewayStatusSnapshot = GatewaySnapshotShared;

/**
 * Live state the gateway can show about what an agent thread is doing.
 * Surfaced via `AgentHandler.queryStatus?(threadId)`.
 */
export interface ThreadStatus {
    readonly threadId: string;
    readonly entryAgent: string;
    readonly activeTasks: ReadonlyArray<TaskSummary>;
    readonly recentTasks: ReadonlyArray<TaskSummary>;
    /**
     * TODAY's input/output token totals for this thread, plus the per-model
     * breakdown sorted heaviest first. Undefined when the agent layer
     * hasn't wired token persistence or there's been no LLM activity today.
     */
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
    /**
     * Team roster — one entry per configured non-main agent. Populated when
     * the agent layer exposes team state; undefined otherwise.
     */
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
    /**
     * Timestamp of the worker's most recent task completion or failure
     * (ms epoch). Populated when the agent layer has seen at least one
     * delegation; undefined before the first task. Used by /status to
     * show "idle · last active 43s ago" instead of a bare "idle".
     */
    readonly lastActiveAt?: number;
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

/**
 * Markdown reply + optional structured rendering hints. Platform adapters
 * render `text` as-is; future work can add `channelData` for Discord
 * embeds / Telegram inline keyboards / Slack blocks.
 */
export interface CommandResult {
    readonly text: string;
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult | null>;

export interface CommandDef {
    /** Canonical name without the leading "/". */
    readonly name: string;
    /** Extra names that map to the same handler ("s" → "status", "?" → "help"). */
    readonly aliases?: readonly string[];
    /** One-line description shown by /help. */
    readonly description: string;
    /**
     * Gate — 'user' is always allowed, 'admin' requires the caller to be an
     * owner peer (future: plumbed from config allowlist). For v1 everything
     * is user-scoped; admin is a placeholder for when we add sensitive ops.
     */
    readonly scope?: 'user' | 'admin';
    readonly handler: CommandHandler;
}
