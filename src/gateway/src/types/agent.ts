export type InvokeRole = 'user' | 'system';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Background-task lifecycle event:
 *   task_start    — typing + ⏳ reaction begin
 *   task_progress — refreshes typing only
 *   task_complete — ⏳ → ✅ + agent wake-up turn
 *   task_error    — ⏳ → ❌ + short error push
 */
export interface ChannelEvent {
    readonly type: 'task_start' | 'task_complete' | 'task_error' | 'task_progress';
    readonly taskId: string;
    readonly result?: string;
    readonly error?: string;
    readonly progress?: string;
    readonly completedAt: number;
    /**
     *   always      — agent always calls send_message (default)
     *   conditional — agent decides based on newsworthiness
     *   silent      — no agent turn (side-effect only)
     */
    readonly deliveryMode?: 'always' | 'conditional' | 'silent';
}

export interface BackgroundTask {
    readonly id: string;
    readonly threadId: string;
    readonly peerId: string;
    readonly status: TaskStatus;
    readonly description: string;
    readonly result?: string;
    readonly error?: string;
    readonly startedAt: number;
    readonly completedAt?: number;
    readonly lastProgressAt?: number;
    readonly retryCount: number;
    readonly maxRetries: number;
}

export interface IEventQueue {
    push(event: ChannelEvent): void;
    tryDequeue(): ChannelEvent | null;
    waitForEvent(timeoutMs: number): Promise<boolean>;
}

/** Persistent task store for crash-resilient background tasks. */
export interface ITaskStore {
    create(task: BackgroundTask): Promise<void>;
    update(
        id: string,
        fields: Partial<
            Pick<
                BackgroundTask,
                'status' | 'result' | 'error' | 'completedAt' | 'lastProgressAt' | 'retryCount'
            >
        >,
    ): Promise<void>;
    get(id: string): Promise<BackgroundTask | null>;
    findByStatus(status: TaskStatus): Promise<BackgroundTask[]>;
    findByThread(threadId: string): Promise<BackgroundTask[]>;
    findUndelivered(): Promise<BackgroundTask[]>;
    markDelivered(id: string): Promise<void>;
}

/** Channel adapters translate these to native rendering or drop silently. */
export interface ReplyOptions {
    readonly buttons?: ReadonlyArray<{
        readonly label: string;
        readonly value: string;
        readonly style?: 'primary' | 'secondary' | 'success' | 'danger';
    }>;
    /** Each item must specify either `url` or `data` (base64). */
    readonly media?: ReadonlyArray<{
        readonly type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
        readonly url?: string;
        readonly data?: string;
        readonly mimeType?: string;
        readonly fileName?: string;
        readonly caption?: string;
    }>;
}

/** Channels without native polls render a numbered text fallback. */
export interface SendPollOptions {
    readonly anonymous?: boolean;
    readonly allowMultiple?: boolean;
    readonly durationHours?: number;
}

export interface AgentCallbacks {
    readonly onReply: (text: string, options?: ReplyOptions) => Promise<void>;
    readonly sendPoll: (
        question: string,
        options: readonly string[],
        pollOptions?: SendPollOptions,
    ) => Promise<void>;
    /** Atomic read+clear of mid-turn user input. Returns [] when empty. */
    readonly drainPending: () => string[];
    readonly onProgress: (taskId: string, message: string) => void;
    readonly setDidSendViaTool: () => void;
    readonly eventQueue: IEventQueue;
    readonly taskStore?: ITaskStore;
    readonly pending: ReadonlyArray<string>;
    readonly signal: AbortSignal;
    /** Reaction does not count as a reply; does not flip didSendViaTool. */
    readonly reactToUserMessage?: (
        emoji: string,
        messageId?: string,
    ) => Promise<void>;

    /** Platform name — e.g. 'telegram', 'discord'. */
    readonly channelName: string;

    /** Native interactive surfaces this channel supports. Empty = text-only. */
    readonly channelCapabilities: readonly string[];

    /** For group/channel peers, this is the shared space; `sender` is the speaker. */
    readonly peer: {
        readonly id: string;
        readonly type: 'user' | 'group' | 'channel';
        readonly name?: string;
    };

    /** Meaningful only for group/channel peers. */
    readonly sender?: {
        readonly id: string;
        readonly name?: string;
    };

    readonly messageId?: string;

    /** Per-turn voice overlay (matches personalities.yaml key). */
    readonly personality?: string;

    /** Lines rendered verbatim in the system prompt's `<runtime>` block. */
    readonly runtimeHints?: readonly string[];

    /** Wired only when the channel supports edit-based streaming. */
    readonly onChunk?: (chunk: AgentChunk) => void;
}

/** Streaming events the agent emits during a turn. */
export type AgentChunk =
    | { readonly type: 'text_delta'; readonly text: string }
    | { readonly type: 'thinking'; readonly text: string }
    | { readonly type: 'tool_start'; readonly toolName: string; readonly args?: string }
    | { readonly type: 'tool_result'; readonly toolName: string; readonly result?: string };

export interface AgentResult {
    readonly reply: string | null;
    readonly didSendViaTool: boolean;
    readonly tokenUsage?: { readonly input: number; readonly output: number };
}

export interface InboundMedia {
    readonly type: string;
    readonly data?: string;
    readonly url?: string;
    readonly mimeType?: string;
    readonly fileName?: string;
}

export interface AgentHandler {
    invoke(
        text: string,
        threadId: string,
        callbacks: AgentCallbacks,
        role?: InvokeRole,
        media?: ReadonlyArray<InboundMedia>,
    ): Promise<AgentResult>;
    /**
     * Optional status snapshot for this thread — what workers are running,
     * what's recently completed. Consumed by the gateway's slash-command
     * layer (e.g. /status). Returns undefined when the thread hasn't been
     * instantiated yet.
     */
    queryStatus?(threadId: string): ThreadStatusSnapshot | undefined;
    /** Cross-thread task list for `flopsy tasks`. */
    queryAllTasks?(filter?: TaskListFilter): AggregateTaskSummary[];
    /** Maps a proactive fire to the peer's active session threadId. */
    resolveProactiveThreadId?(
        channelName: string,
        peer: { id: string; type: 'user' | 'group' | 'channel' },
        source: 'heartbeat' | 'cron',
    ): string | undefined;

    /**
     * Force-close the current session and open a fresh one. Awaits a single
     * LLM extraction to compress + persist profile/notes/directives.
     */
    forceNewSession?(
        rawKey: string,
    ): Promise<{ sessionId: string; summary: string | null } | undefined>;

    /**
     * Summarise message history into a synthetic system message that
     * replaces the checkpoint state. Frees context without losing continuity.
     */
    compactSession?(rawKey: string): Promise<
        { messageCount: number; summary: string } | undefined
    >;

    /**
     * Drop any active plan (drafting or approved). Implementations must
     * clear all matching cached threads for this peer (multiple sessions
     * may co-exist after a /new rotation).
     */
    cancelPlan?(rawKey: string): boolean;

    /** Read-only `/plan` diagnostic. Returns null when no plan exists. */
    getPlanState?(rawKey: string): { mode: 'idle' | 'drafting' | 'approved'; hasPlan: boolean; objective?: string } | null;

    listMcpServers?(): ReadonlyArray<{
        readonly name: string;
        readonly status: 'connected' | 'skipped' | 'failed' | 'disabled';
        readonly reason?: string;
        readonly toolCount?: number;
    }>;
    reloadMcp?(opts?: { evictCachedThreads?: boolean }): Promise<{
        readonly connected: readonly string[];
        readonly skipped: ReadonlyArray<{ name: string; reason: string }>;
        readonly failed: ReadonlyArray<{ name: string; reason: string }>;
        readonly evictedCachedThreads: boolean;
    }>;
}

export interface TaskListFilter {
    readonly threadId?: string;
    readonly status?: ReadonlyArray<TaskStatusSummary['status']>;
    /** Cap applied after sorting newest-first. */
    readonly limit?: number;
}

export interface AggregateTaskSummary extends TaskStatusSummary {
    readonly threadId: string;
}

export interface ThreadStatusSnapshot {
    readonly threadId: string;
    readonly entryAgent: string;
    readonly activeTasks: ReadonlyArray<TaskStatusSummary>;
    readonly recentTasks: ReadonlyArray<TaskStatusSummary>;
    /** Today's token totals; `byModel` sorted heaviest first. */
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
    /** One entry per non-main agent. Main agent excluded. */
    readonly team?: ReadonlyArray<TeamMemberStatus>;
}

export interface TeamMemberStatus {
    readonly name: string;
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
    readonly type: string;
    readonly enabled: boolean;
    readonly status: 'idle' | 'running' | 'disabled';
    /** Populated only when status === 'running'. */
    readonly currentTask?: {
        readonly id: string;
        readonly description: string;
        readonly runningMs: number;
    };
    /** Timestamp of the most recent task completion or failure. */
    readonly lastActiveAt?: number;
}

export interface TaskStatusSummary {
    readonly id: string;
    readonly worker: string;
    readonly description: string;
    readonly status: 'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'killed';
    readonly startedAtMs: number;
    readonly endedAtMs?: number;
    readonly error?: string;
}
