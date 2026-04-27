/**
 * StatusSnapshot — the canonical DTO consumed by every status renderer.
 *
 * Two producers populate it:
 *   - `flopsy status` CLI reads config from disk + optionally fetches live
 *     data from the gateway mgmt HTTP endpoint.
 *   - The slash `/status` handler in the gateway reads directly from the
 *     in-memory engine — no HTTP hop.
 *
 * Both assemble this shape and hand it to one of the renderers.
 */

export type ChannelStatus =
    | 'connected'
    | 'connecting'
    | 'disconnected'
    | 'error'
    | 'disabled'
    | 'unknown';

export type TeamMemberStatus = 'idle' | 'working' | 'disabled';

export interface StatusSnapshot {
    readonly gateway: {
        readonly running: boolean;
        readonly pid?: number;
        readonly uptimeMs?: number;
        readonly host: string;
        readonly port: number;
        readonly version?: string;
        readonly activeThreads?: number;
    };

    readonly channels: ReadonlyArray<{
        readonly name: string;
        readonly enabled: boolean;
        readonly status?: ChannelStatus;
    }>;

    readonly team: ReadonlyArray<{
        readonly name: string;
        readonly enabled: boolean;
        readonly status: TeamMemberStatus;
        readonly currentTask?: string;
        readonly lastActiveAgoMs?: number;
    }>;

    readonly proactive: {
        readonly enabled: boolean;
        readonly running?: boolean;
        readonly heartbeats: { count: number; enabled: number; lastFireAgoMs?: number };
        readonly cron: { count: number; enabled: number; lastFireAgoMs?: number };
        readonly webhooks: { count: number; enabled: boolean; lastReceiveAgoMs?: number };
        readonly stats24h?: {
            readonly delivered: number;
            readonly suppressed: number;
            readonly errors: number;
            readonly retryPending: number;
            readonly suppressedBreakdown?: {
                readonly dedup?: number;
                readonly presence?: number;
                readonly conditional?: number;
                readonly other?: number;
            };
        };
    };

    readonly integrations: {
        readonly auth: ReadonlyArray<{
            readonly provider: string;
            readonly email?: string;
            readonly expiresInMinutes: number;
            readonly expired: boolean;
        }>;
        readonly mcp: {
            readonly enabled: boolean;
            readonly configured: number;
            readonly active: number;
        };
        readonly memory: {
            readonly enabled: boolean;
            readonly embedder?: string;
        };
    };

    readonly paths: {
        readonly config: string;
        readonly state: string;
    };

    /**
     * Aggregate in-flight/recent background work across ALL threads — visible
     * in `flopsy status` (not thread-scoped). The slash `/status` command
     * shows thread-scoped work via the `thread` field instead.
     */
    readonly work?: {
        readonly active: ReadonlyArray<{
            readonly id: string;
            readonly thread?: string;
            readonly worker: string;
            readonly description: string;
            readonly runningMs: number;
        }>;
        readonly recent?: ReadonlyArray<{
            readonly id: string;
            readonly thread?: string;
            readonly worker: string;
            readonly description: string;
            readonly status: 'completed' | 'failed' | 'killed' | 'idle' | string;
            readonly endedAgoMs?: number;
        }>;
    };

    /** Present only for slash `/status` — the chat-side thread context. */
    readonly thread?: {
        readonly entryAgent: string;
        readonly tokensToday?: {
            readonly input: number;
            readonly output: number;
            readonly calls: number;
            readonly byModel?: ReadonlyArray<{
                readonly model: string;
                readonly input: number;
                readonly output: number;
                readonly calls: number;
            }>;
        };
        readonly activeTasks?: ReadonlyArray<{
            readonly id: string;
            readonly worker: string;
            readonly description: string;
            readonly runningMs: number;
        }>;
        readonly recentTasks?: ReadonlyArray<{
            readonly id: string;
            readonly worker: string;
            readonly description: string;
            readonly status: 'completed' | 'failed' | 'killed' | 'idle' | string;
            readonly endedAgoMs?: number;
        }>;
    };

    /** Broken/degraded things surfaced at top of renders. */
    readonly issues?: ReadonlyArray<{
        readonly severity: 'warn' | 'error';
        readonly message: string;
        readonly hint?: string;
    }>;
}
