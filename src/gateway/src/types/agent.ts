export type InvokeRole = 'user' | 'system';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ChannelEvent {
    /**
     * Lifecycle events for background tasks.
     *   - task_start      — task accepted; typing + ⏳ reaction begin
     *   - task_progress   — optional mid-task signal (refreshes typing only)
     *   - task_complete   — success; ⏳ → ✅ + agent wake-up turn
     *   - task_error      — failure; ⏳ → ❌ + short error push
     */
    readonly type: 'task_start' | 'task_complete' | 'task_error' | 'task_progress';
    readonly taskId: string;
    readonly result?: string;
    readonly error?: string;
    readonly progress?: string;
    readonly completedAt: number;
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

/**
 * Optional interactive + media elements to attach to an outbound reply.
 * Channel adapters translate these into native rendering (Telegram inline
 * keyboard + sendPhoto, Discord components + attachment uploads, etc.);
 * channels without a capability drop silently.
 */
export interface ReplyOptions {
    readonly buttons?: ReadonlyArray<{
        readonly label: string;
        readonly value: string;
        readonly style?: 'primary' | 'secondary' | 'success' | 'danger';
    }>;
    /**
     * File attachments to send alongside the text. Each item must specify
     * either `url` (http/https or local file path) OR `data` (base64). The
     * adapter picks native upload paths per type (sendPhoto/sendVideo/etc.
     * on Telegram, Attachment on Discord, etc.).
     */
    readonly media?: ReadonlyArray<{
        readonly type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
        readonly url?: string;
        readonly data?: string;
        readonly mimeType?: string;
        readonly fileName?: string;
        readonly caption?: string;
    }>;
}

/**
 * Options for native polls. Only honoured by channels with native poll
 * support (Telegram, Discord); others render a numbered text fallback.
 */
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
    /**
     * Atomically returns and clears the queue of user messages received
     * during this turn. Used by the `messageQueue` interceptor to inject
     * mid-turn input so long tool loops react without the user having to
     * wait for the turn to finish. Must be safe to call from any interceptor
     * hook; returns [] when nothing queued.
     */
    readonly drainPending: () => string[];
    readonly onProgress: (taskId: string, message: string) => void;
    readonly setDidSendViaTool: () => void;
    readonly eventQueue: IEventQueue;
    readonly taskStore?: ITaskStore;
    readonly pending: ReadonlyArray<string>;
    readonly signal: AbortSignal;
    /**
     * Drop an emoji reaction on the user's last message (or on a specific
     * message by id). Optional — platforms that don't support reactions
     * no-op silently. Does NOT count as a reply, does NOT flip
     * didSendViaTool.
     */
    readonly reactToUserMessage?: (
        emoji: string,
        messageId?: string,
    ) => Promise<void>;

    // --- Message context the gateway already has; passed explicitly so the
    //     handler and agent don't have to re-parse the threadId. ---

    /** Platform the message arrived on — e.g. 'telegram', 'discord'. */
    readonly channelName: string;

    /**
     * Interactive surfaces this channel renders natively: 'buttons', 'polls',
     * 'select', 'components'. Plumbed straight from `Channel.capabilities` so
     * the agent's runtime block can tell the model what's available on THIS
     * turn's channel. Empty/undefined means text-only — the agent should
     * fall back to numbered prompts instead of button-shaped tools.
     */
    readonly channelCapabilities: readonly string[];

    /**
     * The conversation peer. For DMs this IS the user. For groups/channels
     * this is the shared space, and `sender` carries the individual speaker.
     */
    readonly peer: {
        readonly id: string;
        readonly type: 'user' | 'group' | 'channel';
        readonly name?: string;
    };

    /**
     * Individual speaker (only meaningful for group/channel peers).
     * For DMs this is typically the same as `peer`.
     */
    readonly sender?: {
        readonly id: string;
        readonly name?: string;
    };

    /** Platform-native id of the message that triggered this turn. */
    readonly messageId?: string;
}

export interface AgentChunk {
    readonly type: 'text_delta' | 'tool_start' | 'tool_result' | 'done';
    readonly text?: string;
    readonly toolName?: string;
    readonly toolResult?: string;
}

export interface StreamingCallbacks extends AgentCallbacks {
    readonly onChunk: (chunk: AgentChunk) => void;
}

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
    stream?(
        text: string,
        threadId: string,
        callbacks: StreamingCallbacks,
        role?: InvokeRole,
    ): AsyncIterable<AgentChunk>;
    /**
     * Optional status snapshot for this thread — what workers are running,
     * what's recently completed. Consumed by the gateway's slash-command
     * layer (e.g. /status). Returns undefined when the thread hasn't been
     * instantiated yet.
     */
    queryStatus?(threadId: string): ThreadStatusSnapshot | undefined;
    /**
     * Aggregate task list across ALL threads — for `flopsy tasks` and the
     * top-level `flopsy status` work surface. Returns undefined when the
     * agent layer doesn't track tasks (tests, minimal stubs).
     */
    queryAllTasks?(filter?: TaskListFilter): AggregateTaskSummary[];
    /**
     * Resolve the effective threadId for a proactive fire targeting a known
     * peer. Maps `channelName + peer` → the peer's active session threadId
     * (`<peerId>#<sessionId>`). Returns undefined when the session layer is
     * not available (tests, stubs, or before the first inbound message).
     *
     * Sources: 'heartbeat' or 'cron' — never extends lastUserMessageAt.
     */
    resolveProactiveThreadId?(
        channelName: string,
        peer: { id: string; type: 'user' | 'group' | 'channel' },
        source: 'heartbeat' | 'cron',
    ): string | undefined;

    /**
     * Force-close the peer's current session and open a fresh one. Used by
     * the `/new` slash command. The `rawKey` is the peer routing key
     * (`channel:scope:nativeId`). Returns the new sessionId for display,
     * or undefined if the session layer is not available.
     */
    forceNewSession?(rawKey: string): string | undefined;
}

/** Filter options for `queryAllTasks`. All fields narrow the result set. */
export interface TaskListFilter {
    readonly threadId?: string;
    readonly status?: ReadonlyArray<TaskStatusSummary['status']>;
    /** Cap on the number of results (applied after sorting newest-first). */
    readonly limit?: number;
}

/** `TaskStatusSummary` plus the thread it ran in. */
export interface AggregateTaskSummary extends TaskStatusSummary {
    readonly threadId: string;
}

export interface ThreadStatusSnapshot {
    readonly threadId: string;
    readonly entryAgent: string;
    readonly activeTasks: ReadonlyArray<TaskStatusSummary>;
    readonly recentTasks: ReadonlyArray<TaskStatusSummary>;
    /**
     * TODAY's token totals for this thread, drawn from state.db. Undefined
     * when the agent layer hasn't wired token persistence or there's been
     * no LLM activity yet today. `byModel` is the per-(provider, model)
     * breakdown sorted heaviest first — capped so /status stays readable.
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
     * Team roster — one entry per configured non-main agent. Lets /status
     * show each worker at a glance (idle / running / disabled) and the
     * task description when running. Main agent excluded — its state is
     * the thread header.
     */
    readonly team?: ReadonlyArray<TeamMemberStatus>;
}

export interface TeamMemberStatus {
    readonly name: string;
    /** Static agent config mirrored so `/team` matches `flopsy team show`. */
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
    /** Domain/type from config — 'research', 'deep-research', 'analysis', etc. */
    readonly type: string;
    /** From flopsy.json5: configured-off workers show as 'disabled'. */
    readonly enabled: boolean;
    readonly status: 'idle' | 'running' | 'disabled';
    /** Populated only when status === 'running'. */
    readonly currentTask?: {
        readonly id: string;
        readonly description: string;
        readonly runningMs: number;
    };
    /**
     * Timestamp (ms epoch) of this worker's most recent task completion
     * or failure. Undefined before the first delegation. /status uses it
     * to render "idle · last active 43s ago" alongside bare "idle".
     */
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
