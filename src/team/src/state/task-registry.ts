/**
 * TaskRegistry — per-thread state holder for every Task the main agent has
 * spawned. One registry per TeamHandler thread entry; wired into the
 * delegation tools via the AgentCallbacks / configurable handoff. JS is
 * single-threaded so no locking; all ops are synchronous.
 *
 * What lives here:
 *   - Map<id, TaskState>
 *   - Pending-message helpers for mid-turn injection (per-task, not per-channel)
 *   - Bulk abort for shutdown / user-stop
 *   - Eviction of terminal tasks (keeps the map from growing forever)
 *
 * What does NOT live here:
 *   - Platform-level msg/event queues — the gateway's ChannelWorker owns those
 *   - LLM invocation — TeamHandler and the react agent own that
 *   - Persistence — future work, mirror alongside checkpoints
 */

import {
    type TaskState,
    type TaskStatus,
    type TaskType,
    type TeammateTaskState,
    TASK_ID_PREFIX,
    isActiveStatus,
    isTeammateTask,
    isTerminalStatus,
} from './task-state';

export interface TaskRegistrySnapshot {
    readonly total: number;
    readonly byStatus: Record<TaskStatus, number>;
    readonly byType: Record<TaskType, number>;
}

/** How long to keep terminal tasks before `evictTerminal()` removes them. */
export const DEFAULT_TERMINAL_GRACE_MS = 10 * 60 * 1000; // 10 minutes

export class TaskRegistry {
    private readonly tasks = new Map<string, TaskState>();
    private readonly counters: Record<TaskType, number> = {
        teammate: 0,
        background_job: 0,
        shell: 0,
    };

    /**
     * Hand out the next pretty id for a task type: `t1`, `t2`, `j1`, ...
     * Counters are scoped to this registry (one per thread / conversation),
     * so two conversations can each have their own `#t1` without colliding.
     * Monotonic — never reused within the lifetime of this registry, even
     * after tasks are evicted, so task-notifications can't alias old ids.
     */
    nextId(type: TaskType): string {
        const n = ++this.counters[type];
        return `${TASK_ID_PREFIX[type]}${n}`;
    }

    /** Insert. Duplicate IDs throw — nextId() is monotonic so a collision is a bug. */
    register(task: TaskState): void {
        if (this.tasks.has(task.id)) {
            throw new Error(`TaskRegistry: duplicate task id "${task.id}"`);
        }
        this.tasks.set(task.id, task);
    }

    get(id: string): TaskState | undefined {
        return this.tasks.get(id);
    }

    has(id: string): boolean {
        return this.tasks.has(id);
    }

    /**
     * Replace the whole task record. Callers use the pure transition helpers
     * from task-state.ts (toRunning/toIdle/toTerminal) and write back the
     * result here. Returns false if the id is unknown.
     */
    replace(task: TaskState): boolean {
        if (!this.tasks.has(task.id)) return false;
        this.tasks.set(task.id, task);
        return true;
    }

    /** Shallow patch — spreads `patch` over the existing record. Returns false if unknown. */
    patch<T extends TaskState>(id: string, updater: (current: T) => T): boolean {
        const current = this.tasks.get(id) as T | undefined;
        if (!current) return false;
        this.tasks.set(id, updater(current));
        return true;
    }

    remove(id: string): boolean {
        return this.tasks.delete(id);
    }

    list(): TaskState[] {
        return [...this.tasks.values()];
    }

    listActive(): TaskState[] {
        return this.list().filter(t => isActiveStatus(t.status) || t.status === 'idle');
    }

    listByType<T extends TaskType>(type: T): TaskState[] {
        return this.list().filter(t => t.type === type);
    }

    listByStatus(status: TaskStatus): TaskState[] {
        return this.list().filter(t => t.status === status);
    }

    /**
     * Find the teammate task for a given worker name. A channel has at most
     * one concurrent teammate instance per worker role (legolas never has
     * two parallel sessions on the same channel); this returns the active
     * one if present, else undefined. Used by spawn_background_task to
     * decide whether to reuse an idle teammate or create fresh.
     */
    findActiveTeammate(workerName: string): TeammateTaskState | undefined {
        for (const t of this.tasks.values()) {
            if (!isTeammateTask(t)) continue;
            if (t.workerName !== workerName) continue;
            if (isTerminalStatus(t.status)) continue;
            return t;
        }
        return undefined;
    }

    snapshot(): TaskRegistrySnapshot {
        const byStatus: Record<TaskStatus, number> = {
            pending: 0,
            running: 0,
            idle: 0,
            completed: 0,
            failed: 0,
            killed: 0,
        };
        const byType: Record<TaskType, number> = {
            teammate: 0,
            background_job: 0,
            shell: 0,
        };
        for (const t of this.tasks.values()) {
            byStatus[t.status]++;
            byType[t.type]++;
        }
        return { total: this.tasks.size, byStatus, byType };
    }

    // Pending-message helpers — mid-turn injection between tool-round boundaries.

    /**
     * Append a user message to a teammate's pendingMessages buffer. Returns
     * false if the target is unknown, not a teammate, or in a terminal
     * state — in those cases the caller (WorkerLoop) falls back to a fresh
     * user_message. If the teammate is idle, mid-turn injection is still
     * valid: the next runMainTurn on that teammate will drain them at the
     * start of its first tool round.
     */
    pushPending(taskId: string, text: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) return false;
        if (!isTeammateTask(task)) return false;
        if (isTerminalStatus(task.status)) return false;
        this.tasks.set(taskId, {
            ...task,
            pendingMessages: [...task.pendingMessages, text],
        });
        return true;
    }

    /**
     * Atomically drain all pending messages for a teammate. The interceptor
     * calls this between tool-round boundaries — whatever it returns lands
     * in AgentState.messages as user-role injections.
     */
    drainPending(taskId: string): string[] {
        const task = this.tasks.get(taskId);
        if (!task || !isTeammateTask(task)) return [];
        if (task.pendingMessages.length === 0) return [];
        const drained = task.pendingMessages;
        this.tasks.set(taskId, { ...task, pendingMessages: [] });
        return drained;
    }

    /**
     * Abort every active task's whole or current-turn controller. Used by
     * the channel when it receives an abort command (`all_tasks` or `channel`
     * scope). Returns the count of tasks that actually received an abort.
     */
    abortAllActive(scope: 'whole' | 'current_turn'): number {
        let n = 0;
        for (const t of this.tasks.values()) {
            if (isTerminalStatus(t.status)) continue;
            const pair = t.abortPair;
            if (!pair) continue;
            if (scope === 'whole') pair.whole.abort();
            else pair.currentTurn.abort();
            n++;
        }
        return n;
    }

    /**
     * Remove terminal tasks older than `ageMs`. Called periodically to keep
     * the map from growing forever in long-running sessions. Returns the
     * number of evictions.
     */
    evictTerminal(ageMs: number = DEFAULT_TERMINAL_GRACE_MS, now: number = Date.now()): number {
        let n = 0;
        for (const [id, t] of this.tasks) {
            if (!isTerminalStatus(t.status)) continue;
            const endedAt = t.endedAt ?? t.createdAt;
            if (now - endedAt < ageMs) continue;
            this.tasks.delete(id);
            n++;
        }
        return n;
    }

    /** Count of entries, including terminal. For tests and diagnostics. */
    size(): number {
        return this.tasks.size;
    }
}
