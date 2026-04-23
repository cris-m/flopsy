/**
 * Task state — one typed record per background unit of work in a Channel.
 *
 * Inspired by Claude Code's AppState.tasks pattern: every piece of deferred
 * work (a running sub-agent, a long shell command, a teammate turn) is a Task
 * with the same lifecycle contract. The main agent itself is NOT a Task — it's
 * the persistent conductor; everything it spawns is.
 *
 * Two abort controllers per task:
 *   - abortController         → kills the task permanently
 *   - currentWorkAbortController → aborts only the current turn; task stays
 *                                   alive and resumable (only relevant for
 *                                   teammate tasks that can take follow-ups)
 */

import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type TaskType =
    | 'teammate' // persistent named worker (legolas, gimli) the leader can talk to again
    | 'background_job' // ephemeral fire-and-forget unit (research scrape, file crawl)
    | 'shell'; // long-running shell command

export type TaskStatus =
    | 'pending' // created, not yet running
    | 'running' // actively executing a turn
    | 'idle' // running but waiting for input (only teammate tasks)
    | 'completed' // finished successfully
    | 'failed' // finished with error
    | 'killed'; // aborted by user or leader

/** True once the task will not transition further. */
export function isTerminalStatus(status: TaskStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'killed';
}

/** True while the task is still doing work (not idle, not done). */
export function isActiveStatus(status: TaskStatus): boolean {
    return status === 'pending' || status === 'running';
}

/**
 * Task IDs carry a type-prefix so a glance at the ID tells you what it is.
 *
 *   t1, t2, t3   = teammate tasks   (legolas, saruman, gimli delegations)
 *   j1, j2, j3   = background jobs  (fire-and-forget spawns)
 *   s1, s2, s3   = shell
 *
 * IDs are monotonic per TaskRegistry (= per thread), so users see `#t1`,
 * `#t2` instead of opaque random strings. TaskRegistry owns the counters;
 * call `registry.nextId(type)` when building a task.
 */
export const TASK_ID_PREFIX: Record<TaskType, string> = {
    teammate: 't',
    background_job: 'j',
    shell: 's',
};

/**
 * Random fallback for tests and any call site without a registry. Keep the
 * format short and underscore-free so it's still readable if it leaks into
 * a UI: `t3a7`, `jk9f`. Production paths should prefer `registry.nextId`.
 */
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function generateTaskId(type: TaskType): string {
    const prefix = TASK_ID_PREFIX[type];
    const bytes = randomBytes(4);
    let id = prefix;
    for (let i = 0; i < 4; i++) {
        id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length];
    }
    return id;
}

// ---------------------------------------------------------------------------
// Abort pair — the Claude-Code two-controller pattern.
// ---------------------------------------------------------------------------

export interface AbortPair {
    /** Kills the task permanently — it will NOT accept more work afterward. */
    readonly whole: AbortController;
    /**
     * Aborts the current turn only. After abort, the task transitions to
     * `idle` and can receive another turn. Only meaningful for teammate
     * tasks; background_job and shell tasks don't have "turns" in this sense.
     */
    readonly currentTurn: AbortController;
}

export function createAbortPair(): AbortPair {
    return { whole: new AbortController(), currentTurn: new AbortController() };
}

/**
 * Replace just the per-turn controller. Called after a turn finishes so the
 * next turn gets a fresh signal. The whole controller is untouched.
 */
export function rotateCurrentTurnController(pair: AbortPair): AbortPair {
    return { whole: pair.whole, currentTurn: new AbortController() };
}

// ---------------------------------------------------------------------------
// State shapes
// ---------------------------------------------------------------------------

export interface TaskStateBase {
    readonly id: string;
    readonly type: TaskType;
    readonly description: string;
    readonly createdAt: number;
    readonly toolUseId?: string; // ID of the spawn tool call that created this
    status: TaskStatus;
    endedAt?: number;
    error?: string;
    /** Serialised whenever AppState is written to disk; runtime-only fields are stripped. */
    abortPair?: AbortPair;
    /**
     * Once true, the leader has been told this task is done — prevents
     * double-enqueueing the same task-notification into the command queue.
     */
    notified: boolean;
}

/**
 * Teammate task — a named, persistent worker the leader addressed by role.
 * Legolas and Gimli both instantiate this type.
 *
 * Unlike `background_job`, a teammate can receive follow-up turns: leader
 * spawns once, then delegates multiple tasks in sequence ("research X", then
 * "drill deeper into Y"). The teammate sits `idle` between turns rather than
 * being torn down.
 */
export interface TeammateTaskState extends TaskStateBase {
    readonly type: 'teammate';
    readonly workerName: string; // matches AgentDefinition.name in flopsy.json5
    readonly leaderTaskId?: string; // which teammate spawned this (undefined for direct-from-main)
    readonly depth: number; // 0 = spawned by main, 1 = spawned by a teammate (capped)
    /**
     * Messages queued mid-turn via user injection or inter-teammate mailbox.
     * Drained at tool-round boundaries by the mid-turn-injector interceptor.
     */
    pendingMessages: string[];
    /**
     * Latest streamed result from the teammate's last turn. Consumed by the
     * leader's retrigger turn; cleared when the leader acknowledges.
     */
    lastResult?: string;
    /** Cumulative token + tool usage for reporting / caps. */
    toolUseCount: number;
    tokenCount: number;
}

/**
 * Background job — ephemeral, detached, one-shot. No follow-up possible: when
 * the Promise resolves, the job is done and the result is pushed to the
 * command queue as a task-notification.
 */
export interface BackgroundJobTaskState extends TaskStateBase {
    readonly type: 'background_job';
    readonly prompt: string;
    readonly leaderTaskId?: string;
    readonly depth: number;
    result?: string;
}

/**
 * Shell task — long-running shell command. Separate from background_job
 * because its output is raw text streaming, not a model turn.
 */
export interface ShellTaskState extends TaskStateBase {
    readonly type: 'shell';
    readonly command: string;
    exitCode?: number;
    stdoutFile?: string;
    stderrFile?: string;
}

export type TaskState = TeammateTaskState | BackgroundJobTaskState | ShellTaskState;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isTeammateTask(t: TaskState | undefined): t is TeammateTaskState {
    return t?.type === 'teammate';
}

export function isBackgroundJobTask(
    t: TaskState | undefined,
): t is BackgroundJobTaskState {
    return t?.type === 'background_job';
}

export function isShellTask(t: TaskState | undefined): t is ShellTaskState {
    return t?.type === 'shell';
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createTeammateTask(
    args: Pick<TeammateTaskState, 'workerName' | 'description' | 'depth'> & {
        leaderTaskId?: string;
        toolUseId?: string;
        /** Caller-provided id (from `registry.nextId('teammate')`); falls back to random. */
        id?: string;
    },
): TeammateTaskState {
    return {
        id: args.id ?? generateTaskId('teammate'),
        type: 'teammate',
        workerName: args.workerName,
        description: args.description,
        leaderTaskId: args.leaderTaskId,
        toolUseId: args.toolUseId,
        depth: args.depth,
        createdAt: Date.now(),
        status: 'pending',
        notified: false,
        abortPair: createAbortPair(),
        pendingMessages: [],
        toolUseCount: 0,
        tokenCount: 0,
    };
}

export function createBackgroundJobTask(
    args: Pick<BackgroundJobTaskState, 'prompt' | 'description' | 'depth'> & {
        leaderTaskId?: string;
        toolUseId?: string;
        /** Caller-provided id (from `registry.nextId('background_job')`). */
        id?: string;
    },
): BackgroundJobTaskState {
    return {
        id: args.id ?? generateTaskId('background_job'),
        type: 'background_job',
        prompt: args.prompt,
        description: args.description,
        leaderTaskId: args.leaderTaskId,
        toolUseId: args.toolUseId,
        depth: args.depth,
        createdAt: Date.now(),
        status: 'pending',
        notified: false,
        abortPair: createAbortPair(),
    };
}

export function createShellTask(
    args: Pick<ShellTaskState, 'command' | 'description'> & { toolUseId?: string; id?: string },
): ShellTaskState {
    return {
        id: args.id ?? generateTaskId('shell'),
        type: 'shell',
        command: args.command,
        description: args.description,
        toolUseId: args.toolUseId,
        createdAt: Date.now(),
        status: 'pending',
        notified: false,
        abortPair: createAbortPair(),
    };
}

// ---------------------------------------------------------------------------
// Transitions — centralized so the status graph is enforced in one place.
// ---------------------------------------------------------------------------

export type TransitionResult<T extends TaskState> =
    | { ok: true; task: T }
    | { ok: false; reason: string; task: T };

/**
 * Mark the task as running. Only valid from `pending` or `idle`.
 */
export function toRunning<T extends TaskState>(task: T): TransitionResult<T> {
    if (task.status !== 'pending' && task.status !== 'idle') {
        return { ok: false, reason: `cannot run from status="${task.status}"`, task };
    }
    return { ok: true, task: { ...task, status: 'running' } };
}

/**
 * Mark a teammate task as idle (finished a turn, open to follow-ups).
 * Only valid for teammate tasks currently in `running`.
 */
export function toIdle(
    task: TeammateTaskState,
    lastResult?: string,
): TransitionResult<TeammateTaskState> {
    if (task.status !== 'running') {
        return { ok: false, reason: `cannot idle from status="${task.status}"`, task };
    }
    return { ok: true, task: { ...task, status: 'idle', lastResult } };
}

/**
 * Mark as completed / failed / killed. Terminal, no further transitions.
 *
 * `result` lands on the task-type-appropriate field: `lastResult` for
 * teammates (so the leader's retrigger turn can read it), `result` for
 * background jobs (one-shot payload), nowhere for shell (its output lives
 * in files on disk).
 */
export function toTerminal<T extends TaskState>(
    task: T,
    status: 'completed' | 'failed' | 'killed',
    details: { result?: string; error?: string } = {},
): TransitionResult<T> {
    if (isTerminalStatus(task.status)) {
        return { ok: false, reason: `already terminal: "${task.status}"`, task };
    }
    const base = { status, endedAt: Date.now(), error: details.error } as const;
    if (isTeammateTask(task)) {
        const next: TeammateTaskState = {
            ...task,
            ...base,
            lastResult: details.result ?? task.lastResult,
        };
        return { ok: true, task: next as T };
    }
    if (isBackgroundJobTask(task)) {
        const next: BackgroundJobTaskState = { ...task, ...base, result: details.result };
        return { ok: true, task: next as T };
    }
    // Shell — error is carried; payload is on disk already.
    const next: ShellTaskState = { ...(task as ShellTaskState), ...base };
    return { ok: true, task: next as T };
}
