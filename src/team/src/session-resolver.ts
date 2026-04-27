import { createLogger } from '@flopsy/shared';
import type { LearningStore, SessionRow, SessionSource, SessionCloseReason } from './harness/storage/learning-store';

const log = createLogger('session-resolver');

const DEFAULT_DAILY_RESET_HOUR = 4;        // 4am local — quiet hour for both APAC + EMEA
const DEFAULT_IDLE_MINUTES = 24 * 60;       // 24h idle = new session

const SESSION_SEPARATOR = '#';

export type ResetMode = 'none' | 'daily' | 'idle' | 'both';

export interface SessionResetPolicy {
    /**
     * Which rotation triggers are active. Default 'both' (daily AND idle).
     * 'none' disables rotation — sessions live forever (debug only).
     */
    mode?: ResetMode;
    /** Local hour at which the daily boundary falls. Default 4 (4am). */
    atHour?: number;
    /** Idle minutes before a new session is opened on next message. Default 1440 (24h). */
    idleMinutes?: number;
}

export interface ResolveOptions {
    source: SessionSource;
    /** True when triggered by /new — force a new session even if current is fresh. */
    force?: boolean;
}

export interface ResolveResult {
    /** `<peer_id>#<session_id>` — what handler/checkpointer should use. */
    threadId: string;
    peerId: string;
    sessionId: string;
    /** True if a new session was opened on this call. */
    isNew: boolean;
    /** Why the previous session closed (only set when isNew=true and a previous existed). */
    closeReason?: SessionCloseReason;
    /** The session ID that was closed, composed with peerId to form the previous threadId. */
    previousSessionId?: string;
}

/**
 * SessionResolver — maps a permanent peer-id to an effective threadId
 * carrying the active session.
 *
 * On every inbound user message (and every proactive fire), the gateway calls
 * `resolve(peerId, { source })`. This:
 *   1. Upserts the peer row (lazy migration — first encounter creates it).
 *   2. Looks up the peer's active session.
 *   3. Evaluates the reset policy (daily / idle / forced).
 *   4. Closes the stale session and opens a fresh one if needed.
 *   5. Returns the effective threadId (`<peer_id>#<session_id>`).
 *
 * Critical invariants (OpenClaw / Hermes pattern):
 *   - Only `source: 'user'` extends `last_user_message_at`. Heartbeats and
 *     cron fires re-use the active session if fresh, but never refresh
 *     freshness — a dead session can't be kept alive by background ticks.
 *   - The peer is permanent (lifetime of the user). Sessions are bounded.
 *   - All facts/preferences attach to the peer (existing facts table is
 *     keyed by user_id which corresponds to peer_native_id) — survives
 *     rotation by design.
 */
export class SessionResolver {
    private readonly mode: ResetMode;
    private readonly atHour: number;
    private readonly idleMs: number;

    constructor(
        private readonly store: LearningStore,
        policy: SessionResetPolicy = {},
    ) {
        this.mode = policy.mode ?? 'both';
        this.atHour = policy.atHour ?? DEFAULT_DAILY_RESET_HOUR;
        this.idleMs = (policy.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
    }

    /**
     * Resolve the effective threadId for an incoming event.
     */
    resolve(
        peerId: string,
        peerInfo: { channel: string; scope: string; peerNativeId: string },
        opts: ResolveOptions,
    ): ResolveResult {
        // Lazy migration — first message ever from this peer creates the row.
        this.store.upsertPeer({
            peerId,
            channel: peerInfo.channel,
            scope: peerInfo.scope,
            peerNativeId: peerInfo.peerNativeId,
        });

        const active = this.store.getActiveSession(peerId);

        // Decide whether to rotate.
        const decision = this.shouldRotate(active, opts);
        if (decision.action === 'reuse' && active) {
            return {
                threadId: this.composeThreadId(peerId, active.sessionId),
                peerId,
                sessionId: active.sessionId,
                isNew: false,
            };
        }

        // Close the previous session (if any) before opening a new one.
        // decision.action must be 'rotate' here — narrowed by elimination.
        let closeReason: SessionCloseReason | undefined;
        if (active && decision.action === 'rotate') {
            this.store.closeSession(active.sessionId, decision.reason);
            closeReason = decision.reason;
        }

        const fresh = this.store.openSession({ peerId, source: opts.source });
        log.info(
            {
                peerId,
                newSessionId: fresh.sessionId,
                source: opts.source,
                closedSessionId: active?.sessionId,
                closeReason,
            },
            'session opened',
        );
        return {
            threadId: this.composeThreadId(peerId, fresh.sessionId),
            peerId,
            sessionId: fresh.sessionId,
            isNew: true,
            ...(closeReason ? { closeReason } : {}),
            ...(active ? { previousSessionId: active.sessionId } : {}),
        };
    }

    /**
     * Bump the active session's turn counter. Called by the inbound handler
     * AFTER a turn completes successfully. `source: 'user'` extends
     * freshness; other sources only count turns.
     */
    touch(peerId: string, source: SessionSource): void {
        const active = this.store.getActiveSession(peerId);
        if (!active) return;
        this.store.touchSession(active.sessionId, source);
    }

    /**
     * For tests / CLI. Decompose an effective threadId into its parts.
     * Returns null if the threadId doesn't carry a session suffix
     * (legacy threads from before PR 4 land in this case).
     */
    static parse(threadId: string): { peerId: string; sessionId: string } | null {
        const idx = threadId.indexOf(SESSION_SEPARATOR);
        if (idx <= 0 || idx === threadId.length - 1) return null;
        return {
            peerId: threadId.slice(0, idx),
            sessionId: threadId.slice(idx + 1),
        };
    }

    // ── internals ──────────────────────────────────────────────────────

    private composeThreadId(peerId: string, sessionId: string): string {
        return `${peerId}${SESSION_SEPARATOR}${sessionId}`;
    }

    private shouldRotate(
        active: SessionRow | null,
        opts: ResolveOptions,
    ): { action: 'reuse' } | { action: 'rotate'; reason: SessionCloseReason } {
        if (!active) return { action: 'rotate', reason: 'migration' };
        if (opts.force) return { action: 'rotate', reason: 'user' };
        if (this.mode === 'none') return { action: 'reuse' };

        const now = Date.now();

        // Daily reset: did the last user message land BEFORE today's atHour?
        if (this.mode === 'daily' || this.mode === 'both') {
            if (active.lastUserMessageAt < this.todayBoundaryMs(now)) {
                return { action: 'rotate', reason: 'daily' };
            }
        }

        // Idle reset: too long since the last user message.
        if (this.mode === 'idle' || this.mode === 'both') {
            if (now - active.lastUserMessageAt > this.idleMs) {
                return { action: 'rotate', reason: 'idle' };
            }
        }

        return { action: 'reuse' };
    }

    /**
     * Compute the local-time milliseconds for "today at atHour:00:00".
     * If `now` is before atHour today, this returns yesterday's atHour
     * (so a 3am message after a 4am boundary is still "today's session").
     */
    private todayBoundaryMs(now: number): number {
        const d = new Date(now);
        const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), this.atHour, 0, 0, 0).getTime();
        // Before the boundary today → yesterday's boundary still applies.
        return candidate <= now ? candidate : candidate - 86_400_000;
    }
}
