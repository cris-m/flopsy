/**
 * AgentStateTracker — in-memory view of background agent lifecycle.
 *
 * Scope: tenant-isolated. Every mutation takes a userId so the main agent
 * tools only ever see their own user's agents. The 1-second elapsed-time
 * interval is .unref()'d so the Node event loop can exit if nothing else
 * keeps it alive.
 */

export type AgentStatus = 'idle' | 'running' | 'busy' | 'completed' | 'failed' | 'paused';

export interface ToolActivity {
    toolName: string;
    input: Record<string, unknown>;
    description?: string;
    startedAt: number;
    durationMs?: number;
}

export interface AgentMetrics {
    toolCount: number;
    tokenCount: number;
    elapsedMs: number;
    lastActivity?: ToolActivity;
    recentActivities: ToolActivity[];
}

export interface AgentState {
    agentId: string;
    userId: string;
    status: AgentStatus;
    isBackgrounded: boolean;
    metrics: AgentMetrics;
    currentTask?: string;
    error?: string;
    startedAt: number;
    finishedAt?: number;
    progress?: number;
}

const MAX_RECENT_ACTIVITIES = 10;

interface StartOptions {
    userId: string;
    backgrounded?: boolean;
    task?: string;
}

/**
 * Per-userId view of the tracker. Handed to callers that only have the
 * userId context (e.g. the main agent's `check_background_status` tool).
 */
export interface TenantTracker {
    updateActivity(
        agentId: string,
        toolName: string,
        input: Record<string, unknown>,
        description?: string,
    ): void;
    updateTokens(agentId: string, inputTokens: number, outputTokens: number): void;
    finishTracking(agentId: string): void;
    failTracking(agentId: string, error: string): void;
    getAgentState(agentId: string): AgentState | undefined;
    isAgentBusy(agentId: string): boolean;
    getBackgroundAgents(): AgentState[];
    getCompletedAgents(sinceMs?: number): AgentState[];
    clearAgent(agentId: string): void;
}

export class AgentStateTracker {
    private readonly states = new Map<string, AgentState>();
    private readonly activityTimers = new Map<string, NodeJS.Timeout>();

    startTracking(agentId: string, opts: StartOptions): void {
        const state: AgentState = {
            agentId,
            userId: opts.userId,
            status: 'running',
            isBackgrounded: opts.backgrounded ?? true,
            currentTask: opts.task,
            metrics: {
                toolCount: 0,
                tokenCount: 0,
                elapsedMs: 0,
                recentActivities: [],
            },
            startedAt: Date.now(),
        };
        this.states.set(agentId, state);
        this.startElapsedTimer(agentId);
    }

    updateActivity(
        agentId: string,
        toolName: string,
        input: Record<string, unknown>,
        description?: string,
    ): void {
        const state = this.states.get(agentId);
        if (!state) return;
        state.status = 'busy';
        state.metrics.toolCount += 1;

        const activity: ToolActivity = { toolName, input, description, startedAt: Date.now() };
        state.metrics.lastActivity = activity;
        state.metrics.recentActivities.push(activity);
        if (state.metrics.recentActivities.length > MAX_RECENT_ACTIVITIES) {
            state.metrics.recentActivities.shift();
        }
    }

    updateTokens(agentId: string, inputTokens: number, outputTokens: number): void {
        const state = this.states.get(agentId);
        if (!state) return;
        state.metrics.tokenCount = inputTokens + outputTokens;
    }

    completeActivity(agentId: string, durationMs: number): void {
        const state = this.states.get(agentId);
        if (!state || !state.metrics.lastActivity) return;
        state.metrics.lastActivity.durationMs = durationMs;
        state.status = 'running';
    }

    pauseAgent(agentId: string): void {
        const state = this.states.get(agentId);
        if (state) state.status = 'paused';
    }

    resumeAgent(agentId: string): void {
        const state = this.states.get(agentId);
        if (state) state.status = 'running';
    }

    finishTracking(agentId: string): void {
        const state = this.states.get(agentId);
        if (!state) return;
        state.status = 'completed';
        state.finishedAt = Date.now();
        this.stopElapsedTimer(agentId);
    }

    failTracking(agentId: string, error: string): void {
        const state = this.states.get(agentId);
        if (!state) return;
        state.status = 'failed';
        state.error = error;
        state.finishedAt = Date.now();
        this.stopElapsedTimer(agentId);
    }

    getAgentState(agentId: string): AgentState | undefined {
        return this.states.get(agentId);
    }

    isAgentBusy(agentId: string): boolean {
        const state = this.states.get(agentId);
        return state?.status === 'busy' || state?.status === 'running';
    }

    getBackgroundAgentsForUser(userId: string): AgentState[] {
        return Array.from(this.states.values()).filter(
            (s) =>
                s.userId === userId &&
                s.isBackgrounded &&
                (s.status === 'running' || s.status === 'busy'),
        );
    }

    getCompletedAgentsForUser(userId: string, sinceMs = 5_000): AgentState[] {
        const cutoff = Date.now() - sinceMs;
        return Array.from(this.states.values()).filter(
            (s) =>
                s.userId === userId &&
                s.status === 'completed' &&
                s.finishedAt !== undefined &&
                s.finishedAt > cutoff,
        );
    }

    /**
     * Unscoped view — tests and diagnostics only. Production callers should
     * use `getBackgroundAgentsForUser` / `forUser(userId)` to avoid leaking
     * state across tenants.
     */
    getAllBackgroundAgents(): AgentState[] {
        return Array.from(this.states.values()).filter(
            (s) => s.isBackgrounded && (s.status === 'running' || s.status === 'busy'),
        );
    }

    clearAgent(agentId: string): void {
        this.states.delete(agentId);
        this.stopElapsedTimer(agentId);
    }

    /**
     * GC completed/failed agents whose finishedAt is older than maxAgeMs.
     * Idempotent; safe to call on a schedule.
     */
    cleanup(maxAgeMs = 3_600_000): void {
        const cutoff = Date.now() - maxAgeMs;
        for (const [agentId, state] of this.states) {
            const ts = state.finishedAt ?? state.startedAt;
            if (ts < cutoff && state.status !== 'running' && state.status !== 'busy') {
                this.clearAgent(agentId);
            }
        }
    }

    /**
     * Return a view bound to a single userId — every call is already scoped.
     * Hand this to code that only has a userId (e.g. core tool `execute`).
     */
    forUser(userId: string): TenantTracker {
        return {
            updateActivity: (agentId, toolName, input, description) => {
                if (this.ownedBy(agentId, userId)) {
                    this.updateActivity(agentId, toolName, input, description);
                }
            },
            updateTokens: (agentId, inputTokens, outputTokens) => {
                if (this.ownedBy(agentId, userId)) {
                    this.updateTokens(agentId, inputTokens, outputTokens);
                }
            },
            finishTracking: (agentId) => {
                if (this.ownedBy(agentId, userId)) this.finishTracking(agentId);
            },
            failTracking: (agentId, error) => {
                if (this.ownedBy(agentId, userId)) this.failTracking(agentId, error);
            },
            getAgentState: (agentId) =>
                this.ownedBy(agentId, userId) ? this.states.get(agentId) : undefined,
            isAgentBusy: (agentId) =>
                this.ownedBy(agentId, userId) ? this.isAgentBusy(agentId) : false,
            getBackgroundAgents: () => this.getBackgroundAgentsForUser(userId),
            getCompletedAgents: (sinceMs) => this.getCompletedAgentsForUser(userId, sinceMs),
            clearAgent: (agentId) => {
                if (this.ownedBy(agentId, userId)) this.clearAgent(agentId);
            },
        };
    }

    private ownedBy(agentId: string, userId: string): boolean {
        return this.states.get(agentId)?.userId === userId;
    }

    // Timer management --------------------------------------------------------

    private startElapsedTimer(agentId: string): void {
        const timer = setInterval(() => {
            const state = this.states.get(agentId);
            if (state) state.metrics.elapsedMs = Date.now() - state.startedAt;
        }, 1000);
        // Don't keep the event loop alive just for elapsed-time bookkeeping.
        timer.unref?.();
        this.activityTimers.set(agentId, timer);
    }

    private stopElapsedTimer(agentId: string): void {
        const timer = this.activityTimers.get(agentId);
        if (timer) {
            clearInterval(timer);
            this.activityTimers.delete(agentId);
        }
    }
}

let globalTracker: AgentStateTracker | undefined;

export function getAgentStateTracker(): AgentStateTracker {
    if (!globalTracker) globalTracker = new AgentStateTracker();
    return globalTracker;
}
