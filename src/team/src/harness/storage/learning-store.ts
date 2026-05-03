import Database from 'better-sqlite3';
import { realpathSync } from 'fs';
import { dirname, resolve } from 'path';
import { createLogger, resolveFlopsyHome, resolveWorkspacePath, ensureDir } from '@flopsy/shared';

const log = createLogger('learning-store');

/** Current schema version. Bump when adding new tables or columns. */
const SCHEMA_VERSION = 2;

/** Concurrency tuning — mirrors Hermes' proven pattern for multi-process SQLite. */
const BUSY_TIMEOUT_MS = 1_000;
const WRITE_MAX_RETRIES = 15;
const WRITE_RETRY_MIN_MS = 20;
const WRITE_RETRY_MAX_MS = 150;
const CHECKPOINT_EVERY_N_WRITES = 50;

// Public learning-layer types — minimal, peer-keyed primitives.

export interface ToolFailureRow {
    peerId: string;
    toolName: string;
    errorPattern: string;
    count: number;
    firstSeen: number;
    lastSeen: number;
}

// Raw DB row shapes — mirror the DDL column names (snake_case).
// They live next to the queries so drift shows up at compile time.

interface DbPeerRow {
    peer_id: string;
    channel: string;
    scope: string;
    peer_native_id: string;
    created_at: number;
    last_active_at: number;
    active_session_id: string | null;
}

interface DbSessionRow {
    session_id: string;
    peer_id: string;
    opened_at: number;
    closed_at: number | null;
    close_reason: string | null;
    turn_count: number;
    last_user_message_at: number;
    source: string;
    summary: string | null;
    active_personality: string | null;
    branch_label: string | null;
    parent_session_id: string | null;
}

/** Summed totals across providers/models for a single (thread, date). */
export interface TokenDailyTotal {
    input: number;
    output: number;
    calls: number;
}

/** Per-model breakdown for a single (thread, date). */
export interface TokenDailyByModel extends TokenDailyTotal {
    provider: string;
    model: string;
}

interface DbTokenDeltaArgs {
    threadId: string;
    date: string;
    provider: string;
    model: string;
    input: number;
    output: number;
}

/** Persisted conversation turn — one row per user/assistant message. */
export interface MessageRow {
    id: number;
    userId: string;
    threadId: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
}

/** Search hit: a row plus the FTS5 ranking + an optional snippet. */
export interface MessageSearchHit {
    id: number;
    userId: string;
    threadId: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
    /** FTS5 bm25 score — smaller is a better match. */
    rank: number;
    /** Highlighted excerpt around the match (FTS5 snippet()). */
    snippet: string;
}

interface DbMessageRow {
    id: number;
    user_id: string;
    thread_id: string;
    role: string;
    content: string;
    created_at: number;
}

/** Lifecycle states for a `spawn_background_task` row. */
export type BackgroundTaskStatus =
    | 'running'
    | 'completed'
    | 'delivered'
    | 'failed'
    | 'killed';

/** Persisted background task — durable mirror of in-memory TaskRegistry state. */
export interface BackgroundTaskRow {
    taskId: string;
    threadId: string;
    workerName: string;
    taskPrompt: string;
    toolAllowlist: readonly string[] | null;
    timeoutMs: number | null;
    deliveryMode: string | null;
    status: BackgroundTaskStatus;
    createdAt: number;
    endedAt: number | null;
    result: string | null;
    error: string | null;
    description: string | null;
}

interface DbBackgroundTaskRow {
    task_id: string;
    thread_id: string;
    worker_name: string;
    task_prompt: string;
    tool_allowlist: string | null;
    timeout_ms: number | null;
    delivery_mode: string | null;
    status: BackgroundTaskStatus;
    created_at: number;
    ended_at: number | null;
    result: string | null;
    error: string | null;
    description: string | null;
}

interface DbMessageSearchRow extends DbMessageRow {
    rank: number;
    snippet: string;
}

/**
 * LearningStore — SQLite backend for harness state.
 *
 * Stores:
 *   - PEERS + SESSIONS: session lifecycle and per-peer continuity.
 *   - TOOL FAILURES: per-(peer, tool, error) recurring-error tracking.
 *   - TOKEN accounting: per-(thread, day, provider, model) buckets.
 *   - MESSAGES: user+assistant turns with an FTS5 index for session search.
 *   - BACKGROUND TASKS: durable mirror of in-memory TaskRegistry state.
 *
 * Per-peer agent memory (profile / notes / directives) lives in the
 * unified BaseStore (memory.db) — see SqliteMemoryStore in flopsygraph.
 *
 * Hermes-style concurrency: WAL, 1s busy_timeout, 15-retry write loop with
 * 20-150ms jitter, BEGIN IMMEDIATE transactions, PASSIVE checkpoint every
 * 50 writes. All data scoped by userId for multi-tenant gateways.
 */
export class LearningStore {
    private readonly db: Database.Database;
    private readonly dbPath: string;
    private writeCount = 0;
    private closed = false;
    /** Atomics.wait buffer — sleeps without blocking the event loop. */
    private readonly retrySleepView: Int32Array = new Int32Array(
        new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    );

    constructor(dbPath?: string) {
        this.dbPath = dbPath ?? resolveWorkspacePath('state', 'learning.db');
        ensurePathInAllowedRoots(this.dbPath);
        ensureDir(dirname(this.dbPath));

        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
        this.db.pragma('synchronous = NORMAL');

        this.applySchema();
        log.info({ path: this.dbPath, version: SCHEMA_VERSION }, 'LearningStore ready');
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try {
            this.db.pragma('wal_checkpoint(PASSIVE)');
        } catch {
            /* best-effort */
        }
        this.db.close();
    }

    /**
     * Hand out the underlying SQLite connection so satellite stores
     * (PairingStore, etc.) can share it without opening a second writer.
     * Callers MUST treat the connection as read/write but never close it.
     */
    getDatabase(): Database.Database {
        return this.db;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /**
     * Record a tool failure. UPSERT: same (peer, tool, pattern) triple
     * increments `count` and refreshes `last_seen`. Empty pattern → no-op
     * (some adapters surface blank errors and we don't want to pollute
     * the table with rows that mean nothing).
     */
    recordToolFailure(args: {
        peerId: string;
        toolName: string;
        errorPattern: string;
    }): void {
        const pattern = args.errorPattern.trim();
        if (pattern.length === 0) return;
        const now = Date.now();
        this.runWrite(() => {
            this.db
                .prepare(
                    `INSERT INTO tool_failures
                        (peer_id, tool_name, error_pattern, count, first_seen, last_seen)
                     VALUES (?, ?, ?, 1, ?, ?)
                     ON CONFLICT(peer_id, tool_name, error_pattern) DO UPDATE SET
                        count = count + 1,
                        last_seen = excluded.last_seen`,
                )
                .run(args.peerId, args.toolName, pattern, now, now);
        });
    }

    /**
     * Return the most-recent tool failures for a peer, capped at `limit` and
     * filtered to the last `windowMs` (default 7 days). Sorted by recency
     * with ties broken by repeat count (heavier patterns surface first).
     */
    listRecentToolFailures(
        peerId: string,
        options: { limit?: number; windowMs?: number } = {},
    ): ReadonlyArray<ToolFailureRow> {
        const limit = Math.max(1, Math.min(options.limit ?? 5, 50));
        const windowMs = options.windowMs ?? 7 * 24 * 60 * 60 * 1000;
        const since = Date.now() - windowMs;
        const rows = this.db
            .prepare(
                `SELECT peer_id, tool_name, error_pattern, count, first_seen, last_seen
                   FROM tool_failures
                  WHERE peer_id = ? AND last_seen >= ?
                  ORDER BY last_seen DESC, count DESC
                  LIMIT ?`,
            )
            .all(peerId, since, limit) as Array<{
            peer_id: string;
            tool_name: string;
            error_pattern: string;
            count: number;
            first_seen: number;
            last_seen: number;
        }>;
        return rows.map((r) => ({
            peerId: r.peer_id,
            toolName: r.tool_name,
            errorPattern: r.error_pattern,
            count: r.count,
            firstSeen: r.first_seen,
            lastSeen: r.last_seen,
        }));
    }

    // Peers + sessions (added in PR 4).

    /**
     * Insert peer if not present; refresh `last_active_at` either way.
     * Returns the current row (post-update). Does NOT create a session —
     * the SessionResolver decides when to open one.
     */
    upsertPeer(input: {
        peerId: string;
        channel: string;
        scope: string;
        peerNativeId: string;
    }): PeerRow {
        const now = Date.now();
        this.runWrite(() => {
            this.db
                .prepare(
                    `INSERT INTO peers (peer_id, channel, scope, peer_native_id, created_at, last_active_at, active_session_id)
                     VALUES (?, ?, ?, ?, ?, ?, NULL)
                     ON CONFLICT(peer_id) DO UPDATE SET last_active_at = excluded.last_active_at`,
                )
                .run(input.peerId, input.channel, input.scope, input.peerNativeId, now, now);
        });
        const row = this.getPeer(input.peerId);
        if (!row) throw new Error(`upsertPeer post-condition failed: ${input.peerId}`);
        return row;
    }

    getPeer(peerId: string): PeerRow | null {
        const r = this.db
            .prepare(`SELECT * FROM peers WHERE peer_id = ?`)
            .get(peerId) as DbPeerRow | undefined;
        return r ? rowToPeer(r) : null;
    }

    /**
     * Open a new session for the given peer, marking it as the peer's
     * active session. Caller is responsible for closing the previous
     * active session first (via closeSession).
     */
    openSession(input: {
        peerId: string;
        source: SessionSource;
        openedAt?: number;
    }): SessionRow {
        const sessionId = generateSessionId();
        const openedAt = input.openedAt ?? Date.now();
        this.runWrite(() => {
            this.db
                .prepare(
                    `INSERT INTO sessions
                     (session_id, peer_id, opened_at, closed_at, close_reason, turn_count, last_user_message_at, source, summary, active_personality)
                     VALUES (?, ?, ?, NULL, NULL, 0, ?, ?, NULL, NULL)`,
                )
                .run(sessionId, input.peerId, openedAt, openedAt, input.source);
            this.db
                .prepare(`UPDATE peers SET active_session_id = ?, last_active_at = ? WHERE peer_id = ?`)
                .run(sessionId, openedAt, input.peerId);
        });

        const row = this.getSession(sessionId);
        if (!row) throw new Error(`openSession post-condition failed: ${sessionId}`);
        return row;
    }

    /**
     * Fork the active session into a labeled branch. Atomic:
     *   1. close the source session (close_reason='user')
     *   2. open a new session with `branch_label = label` and
     *      `parent_session_id = src.sessionId`
     *   3. clone messages from the source into the new session so the agent
     *      sees the same prefix when the next turn lands
     *   4. flip peers.active_session_id to the new session
     *
     * Returns the new SessionRow. Throws when:
     *   - the label is already used by this peer (UNIQUE INDEX violation)
     *   - the source session doesn't belong to this peer (defence in depth)
     */
    forkSession(input: {
        peerId: string;
        srcSessionId: string;
        srcThreadId: string;
        newThreadId: (newSessionId: string) => string;
        label: string;
        source: SessionSource;
    }): SessionRow {
        const trimmed = input.label.trim();
        if (trimmed.length === 0) throw new Error('branch label cannot be empty');

        const src = this.getSession(input.srcSessionId);
        if (!src) throw new Error(`forkSession: source session not found: ${input.srcSessionId}`);
        if (src.peerId !== input.peerId) {
            throw new Error('forkSession: source session belongs to a different peer');
        }

        const newSessionId = generateSessionId();
        const now = Date.now();
        const newThreadId = input.newThreadId(newSessionId);

        this.runWrite(() => {
            // 1. close source if still open
            this.db
                .prepare(
                    `UPDATE sessions
                     SET closed_at = ?, close_reason = 'user'
                     WHERE session_id = ? AND closed_at IS NULL`,
                )
                .run(now, input.srcSessionId);

            // 2. open new session, labeled and parented
            this.db
                .prepare(
                    `INSERT INTO sessions
                     (session_id, peer_id, opened_at, closed_at, close_reason,
                      turn_count, last_user_message_at, source,
                      summary, active_personality, branch_label, parent_session_id)
                     VALUES (?, ?, ?, NULL, NULL, 0, ?, ?, NULL, ?, ?, ?)`,
                )
                .run(
                    newSessionId,
                    input.peerId,
                    now,
                    now,
                    input.source,
                    src.activePersonality,
                    trimmed,
                    input.srcSessionId,
                );

            // 3. copy messages — preserves order via shared created_at, and
            // re-running the FTS5 trigger keeps full-text search aligned with
            // the new thread_id so /search hits land in the new branch too.
            this.db
                .prepare(
                    `INSERT INTO messages (user_id, thread_id, role, content, created_at)
                     SELECT user_id, ?, role, content, created_at
                     FROM messages
                     WHERE thread_id = ?`,
                )
                .run(newThreadId, input.srcThreadId);

            // 4. flip peer's active pointer
            this.db
                .prepare(`UPDATE peers SET active_session_id = ?, last_active_at = ? WHERE peer_id = ?`)
                .run(newSessionId, now, input.peerId);
        });

        const newRow = this.getSession(newSessionId);
        if (!newRow) throw new Error(`forkSession post-condition failed: ${newSessionId}`);
        return newRow;
    }

    /**
     * Look up a branch by (peer, label). Returns the session row or null
     * — works regardless of whether the labeled session is currently open
     * or closed (so `/branch switch` can find a dormant branch).
     */
    getSessionByBranchLabel(peerId: string, label: string): SessionRow | null {
        const r = this.db
            .prepare(
                `SELECT * FROM sessions
                  WHERE peer_id = ? AND branch_label = ?
                  LIMIT 1`,
            )
            .get(peerId, label.trim()) as DbSessionRow | undefined;
        return r ? rowToSession(r) : null;
    }

    /**
     * List all branches (labeled sessions) for a peer plus the active
     * session if it's unlabeled — newest first. Powers `/branch list`.
     * Limit defaults to 20; the UI is line-oriented so anything beyond
     * that pushes the active section off-screen.
     */
    listBranchesForPeer(peerId: string, limit = 20): SessionRow[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM sessions
                  WHERE peer_id = ?
                    AND (branch_label IS NOT NULL OR closed_at IS NULL)
                  ORDER BY (closed_at IS NULL) DESC, opened_at DESC
                  LIMIT ?`,
            )
            .all(peerId, Math.max(1, Math.min(limit, 100))) as DbSessionRow[];
        return rows.map(rowToSession);
    }

    /**
     * Switch the active session pointer to a previously-forked branch.
     * Closes the currently-active session (close_reason='user') and re-opens
     * the target by clearing its `closed_at`. Returns the reopened SessionRow,
     * or null when the label is unknown for this peer.
     *
     * Reopening a closed session preserves its original `opened_at` and
     * `branch_label` — only `closed_at` flips back to NULL so the active
     * index treats it as live again. Messages aren't copied: the target
     * already has its own snapshot of history from when it was forked.
     */
    switchToBranch(peerId: string, label: string): SessionRow | null {
        const target = this.getSessionByBranchLabel(peerId, label);
        if (!target) return null;

        const now = Date.now();
        this.runWrite(() => {
            // Close the currently-active session if it isn't already the target.
            const peer = this.getPeer(peerId);
            if (peer?.activeSessionId && peer.activeSessionId !== target.sessionId) {
                this.db
                    .prepare(
                        `UPDATE sessions
                         SET closed_at = ?, close_reason = 'user'
                         WHERE session_id = ? AND closed_at IS NULL`,
                    )
                    .run(now, peer.activeSessionId);
            }
            // Re-open target if it was closed.
            this.db
                .prepare(
                    `UPDATE sessions
                     SET closed_at = NULL, close_reason = NULL,
                         last_user_message_at = ?
                     WHERE session_id = ?`,
                )
                .run(now, target.sessionId);
            this.db
                .prepare(`UPDATE peers SET active_session_id = ?, last_active_at = ? WHERE peer_id = ?`)
                .run(target.sessionId, now, peerId);
        });

        return this.getSession(target.sessionId);
    }

    /**
     * Set or clear the active personality overlay for a session. Pass null
     * to revert to the default voice (SOUL.md only). The /personality slash
     * command writes here. /new naturally clears it because a new session
     * row starts with active_personality=NULL.
     */
    setSessionPersonality(sessionId: string, personalityName: string | null): void {
        this.runWrite(() => {
            this.db
                .prepare(`UPDATE sessions SET active_personality = ? WHERE session_id = ?`)
                .run(personalityName, sessionId);
        });
    }

    /** Read the active personality for a session. Returns null when unset. */
    getSessionPersonality(sessionId: string): string | null {
        const r = this.db
            .prepare(`SELECT active_personality FROM sessions WHERE session_id = ?`)
            .get(sessionId) as { active_personality: string | null } | undefined;
        return r?.active_personality ?? null;
    }

    /** Persist the AI-written recap onto a (typically just-closed) session. */
    setSessionSummary(sessionId: string, summary: string): void {
        this.runWrite(() => {
            this.db
                .prepare(`UPDATE sessions SET summary = ? WHERE session_id = ?`)
                .run(summary, sessionId);
        });
    }

    /**
     * Most-recently-closed session for a peer with a non-empty summary.
     * Used to inject "where we left off" context into the next session.
     */
    getMostRecentClosedSession(peerId: string): SessionRow | null {
        const r = this.db
            .prepare(
                `SELECT * FROM sessions
                  WHERE peer_id = ? AND closed_at IS NOT NULL AND summary IS NOT NULL
                  ORDER BY closed_at DESC
                  LIMIT 1`,
            )
            .get(peerId) as DbSessionRow | undefined;
        return r ? rowToSession(r) : null;
    }

    closeSession(sessionId: string, reason: SessionCloseReason, closedAt: number = Date.now()): void {
        this.runWrite(() => {
            this.db
                .prepare(
                    `UPDATE sessions
                     SET closed_at = ?, close_reason = ?
                     WHERE session_id = ? AND closed_at IS NULL`,
                )
                .run(closedAt, reason, sessionId);
            // Clear peer's active pointer if it was pointing here.
            this.db
                .prepare(
                    `UPDATE peers SET active_session_id = NULL
                     WHERE active_session_id = ?`,
                )
                .run(sessionId);
        });
    }

    getSession(sessionId: string): SessionRow | null {
        const r = this.db
            .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
            .get(sessionId) as DbSessionRow | undefined;
        return r ? rowToSession(r) : null;
    }

    /**
     * Get the peer's currently active session, or null if none.
     * "Active" means closed_at IS NULL AND peer.active_session_id matches.
     */
    getActiveSession(peerId: string): SessionRow | null {
        const peer = this.getPeer(peerId);
        if (!peer || !peer.activeSessionId) return null;
        const session = this.getSession(peer.activeSessionId);
        if (!session || session.closedAt !== null) return null;
        return session;
    }

    /**
     * Bump turn_count on the session. If the source is 'user', also bump
     * last_user_message_at — heartbeat / cron sources do NOT extend
     * freshness (OpenClaw invariant: background activity can't keep a
     * dead session alive indefinitely).
     */
    touchSession(sessionId: string, source: SessionSource, ts: number = Date.now()): void {
        this.runWrite(() => {
            if (source === 'user') {
                this.db
                    .prepare(
                        `UPDATE sessions
                         SET turn_count = turn_count + 1, last_user_message_at = ?
                         WHERE session_id = ?`,
                    )
                    .run(ts, sessionId);
            } else {
                this.db
                    .prepare(`UPDATE sessions SET turn_count = turn_count + 1 WHERE session_id = ?`)
                    .run(sessionId);
            }
        });
    }

    /**
     * UPSERT a model-call delta into the (thread, day, provider, model) bucket.
     * Called from the tokenCounter interceptor's onUpdate hook — one row per
     * unique combo, accumulated in place via ON CONFLICT DO UPDATE.
     *
     * `date` must be the local-time YYYY-MM-DD day the call occurred on.
     * Compute it once in the caller (so the boundary between days is clean
     * even under load) rather than relying on SQLite's `date('now')`.
     */
    recordTokenUsage(args: DbTokenDeltaArgs): void {
        this.runWrite(() => {
            this.db
                .prepare(
                    `INSERT INTO token_usage
                        (thread_id, date, provider, model, input, output, calls, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
                     ON CONFLICT(thread_id, date, provider, model) DO UPDATE SET
                        input      = input + excluded.input,
                        output     = output + excluded.output,
                        calls      = calls + 1,
                        updated_at = excluded.updated_at`,
                )
                .run(
                    args.threadId,
                    args.date,
                    args.provider,
                    args.model,
                    args.input,
                    args.output,
                    Date.now(),
                );
        });
    }

    /** Summed totals for a thread on one day (all providers + models). */
    getTokenDailyTotal(threadId: string, date: string): TokenDailyTotal {
        const row = this.db
            .prepare(
                `SELECT COALESCE(SUM(input), 0) AS input,
                        COALESCE(SUM(output), 0) AS output,
                        COALESCE(SUM(calls), 0) AS calls
                   FROM token_usage
                  WHERE thread_id = ? AND date = ?`,
            )
            .get(threadId, date) as TokenDailyTotal;
        return row;
    }

    /**
     * Per-model breakdown for a thread on one day. Sorted heaviest first so
     * /status can show the biggest consumer at the top and truncate the tail.
     */
    getTokenDailyByModel(threadId: string, date: string): TokenDailyByModel[] {
        return this.db
            .prepare(
                `SELECT provider, model, input, output, calls
                   FROM token_usage
                  WHERE thread_id = ? AND date = ?
                  ORDER BY (input + output) DESC`,
            )
            .all(threadId, date) as TokenDailyByModel[];
    }

    // INSIGHTS — peer-scoped aggregates. Every query MUST scope by (peerId, sinceMs).

    /**
     * Count + role-split of messages persisted in the window. Cheap rollup
     * for the activity card in /insights.
     */
    getMessageCountForPeer(peerId: string, sinceMs: number): {
        total: number;
        user: number;
        assistant: number;
    } {
        const row = this.db
            .prepare(
                `SELECT
                   COUNT(*)                                                 AS total,
                   SUM(CASE WHEN role = 'user'      THEN 1 ELSE 0 END)      AS user,
                   SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END)      AS assistant
                 FROM messages
                 WHERE user_id = ? AND created_at >= ?`,
            )
            .get(peerId, sinceMs) as {
            total: number | null;
            user: number | null;
            assistant: number | null;
        };
        return {
            total: row.total ?? 0,
            user: row.user ?? 0,
            assistant: row.assistant ?? 0,
        };
    }

    /**
     * Sessions stats over the window. Returns the count, total turns, and
     * the top N longest sessions (turn_count desc) so /insights can call
     * out "your longest session was 47 turns about FlopsyBot memory."
     */
    getSessionStatsForPeer(
        peerId: string,
        sinceMs: number,
        longestLimit = 5,
    ): {
        count: number;
        totalTurns: number;
        longest: SessionRow[];
    } {
        const summary = this.db
            .prepare(
                `SELECT COUNT(*) AS count, COALESCE(SUM(turn_count), 0) AS turns
                 FROM sessions
                 WHERE peer_id = ? AND opened_at >= ?`,
            )
            .get(peerId, sinceMs) as { count: number; turns: number };

        const longestRows = this.db
            .prepare(
                `SELECT * FROM sessions
                 WHERE peer_id = ? AND opened_at >= ?
                 ORDER BY turn_count DESC, opened_at DESC
                 LIMIT ?`,
            )
            .all(peerId, sinceMs, Math.max(1, Math.min(longestLimit, 50))) as DbSessionRow[];

        return {
            count: summary.count ?? 0,
            totalTurns: summary.turns ?? 0,
            longest: longestRows.map(rowToSession),
        };
    }

    /**
     * Token usage over the window. Sums across days + sessions, broken down
     * by (provider, model). Sorted heaviest first. Filters by `thread_id LIKE
     * peerId%` because token_usage is keyed by full threadId (peer + session
     * suffix); the LIKE picks up every session for this peer.
     */
    getTokenUsageForPeer(
        peerId: string,
        sinceDateIso: string,
    ): Array<{ provider: string; model: string; input: number; output: number; calls: number }> {
        return this.db
            .prepare(
                `SELECT provider, model,
                        SUM(input)  AS input,
                        SUM(output) AS output,
                        SUM(calls)  AS calls
                 FROM token_usage
                 WHERE thread_id LIKE ? AND date >= ?
                 GROUP BY provider, model
                 ORDER BY (SUM(input) + SUM(output)) DESC`,
            )
            .all(`${peerId}%`, sinceDateIso) as Array<{
            provider: string;
            model: string;
            input: number;
            output: number;
            calls: number;
        }>;
    }

    /**
     * Most-recently-closed sessions in the window with their summary —
     * /insights shows these as a "what you've been working on" list.
     */
    getRecentClosedSessionsWithSummary(
        peerId: string,
        sinceMs: number,
        limit = 5,
    ): SessionRow[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM sessions
                 WHERE peer_id = ?
                   AND closed_at IS NOT NULL
                   AND closed_at >= ?
                   AND summary IS NOT NULL
                 ORDER BY closed_at DESC
                 LIMIT ?`,
            )
            .all(peerId, sinceMs, Math.max(1, Math.min(limit, 50))) as DbSessionRow[];
        return rows.map(rowToSession);
    }

    /**
     * Persist one conversation turn (user input OR assistant reply). Intended
     * to be called by the gateway/handler at the boundaries of `.invoke()` —
     * NOT from inside the React loop. Intermediate tool-call loops are
     * flopsygraph's checkpoint concern; this table is for what the HUMAN
     * and AGENT said to each other, which is what session search operates on.
     *
     * The FTS5 virtual table is kept in sync via AFTER INSERT / AFTER DELETE
     * triggers installed in `applyMessagesSchema()` — callers don't touch FTS
     * directly. Empty content is rejected early (FTS5 would accept it but
     * ranking would be meaningless).
     */
    recordMessage(args: {
        userId: string;
        threadId: string;
        role: 'user' | 'assistant';
        content: string;
        createdAt?: number;
    }): void {
        const trimmed = args.content.trim();
        if (trimmed.length === 0) return;
        const createdAt = args.createdAt ?? Date.now();

        this.runWrite(() => {
            this.db
                .prepare(
                    `INSERT INTO messages (user_id, thread_id, role, content, created_at)
                     VALUES (?, ?, ?, ?, ?)`,
                )
                .run(args.userId, args.threadId, args.role, trimmed, createdAt);
        });
    }

    /**
     * Full-text search across a user's past conversations. Scoped by userId
     * so multi-tenant gateways don't leak across users. The query string is
     * FTS5-syntax — plain words get AND'd by default; callers can use
     * quoted phrases ("new york"), prefix matches (pay*), or boolean
     * operators (coffee OR tea). Query tokens with reserved chars are
     * auto-quoted when they don't look like a phrase/prefix already.
     *
     * Returned hits are ranked by BM25 (smaller = better) with a date recency
     * tie-breaker. The snippet is FTS5's native highlighted excerpt, 64-ish
     * chars on each side of the first match with ‹ › markers that the tool
     * layer can render or strip.
     *
     * @param userId   Owner of the messages to search.
     * @param query    FTS5 match expression (see above).
     * @param options  threadId (restrict to one conversation), limit, since (ms).
     */
    searchMessages(
        userId: string,
        query: string,
        options: {
            threadId?: string;
            limit?: number;
            /** Only return messages created at or after this ms epoch. */
            sinceMs?: number;
        } = {},
    ): MessageSearchHit[] {
        const cleanedQuery = sanitizeFtsQuery(query);
        if (cleanedQuery.length === 0) return [];
        const limit = Math.max(1, Math.min(options.limit ?? 10, 100));

        const whereParts: string[] = ['messages_fts MATCH ?', 'm.user_id = ?'];
        const params: (string | number)[] = [cleanedQuery, userId];
        if (options.threadId) {
            whereParts.push('m.thread_id = ?');
            params.push(options.threadId);
        }
        if (options.sinceMs !== undefined) {
            whereParts.push('m.created_at >= ?');
            params.push(options.sinceMs);
        }
        params.push(limit);

        const rows = this.db
            .prepare(
                `SELECT m.id, m.user_id, m.thread_id, m.role, m.content, m.created_at,
                        bm25(messages_fts) AS rank,
                        snippet(messages_fts, 0, '‹', '›', '…', 16) AS snippet
                   FROM messages_fts
                   JOIN messages m ON m.id = messages_fts.rowid
                  WHERE ${whereParts.join(' AND ')}
                  ORDER BY rank ASC, m.created_at DESC
                  LIMIT ?`,
            )
            .all(...params) as DbMessageSearchRow[];

        return rows.map(rowToMessageSearchHit);
    }

    /**
     * Raw message listing for a thread — no FTS, just the persisted turns in
     * chronological order. Used by the /context slash command and by tests.
     * Capped at `limit` most-recent turns to keep memory bounded on big
     * threads.
     */
    getThreadMessages(threadId: string, limit = 50): MessageRow[] {
        const rows = this.db
            .prepare(
                `SELECT id, user_id, thread_id, role, content, created_at
                   FROM messages
                  WHERE thread_id = ?
                  ORDER BY created_at DESC
                  LIMIT ?`,
            )
            .all(threadId, Math.max(1, Math.min(limit, 500))) as DbMessageRow[];
        // Reverse so caller gets oldest-first.
        return rows.map(rowToMessage).reverse();
    }

    /**
     * Fetch the most-recent messages for a peer across ALL their sessions.
     * Unlike getThreadMessages (session-scoped), this queries by user_id so it
     * crosses session boundaries — used to inject prior-session context after /new.
     *
     * Excludes messages from the given currentThreadId so the current session's
     * in-context messages aren't duplicated in the harness block.
     */
    getRecentMessagesForPeer(
        userId: string,
        limit = 12,
        excludeThreadId?: string,
    ): MessageRow[] {
        const rows = excludeThreadId
            ? (this.db
                .prepare(
                    `SELECT id, user_id, thread_id, role, content, created_at
                       FROM messages
                      WHERE user_id = ?
                        AND thread_id != ?
                      ORDER BY created_at DESC
                      LIMIT ?`,
                )
                .all(userId, excludeThreadId, Math.max(1, Math.min(limit, 100))) as DbMessageRow[])
            : (this.db
                .prepare(
                    `SELECT id, user_id, thread_id, role, content, created_at
                       FROM messages
                      WHERE user_id = ?
                      ORDER BY created_at DESC
                      LIMIT ?`,
                )
                .all(userId, Math.max(1, Math.min(limit, 100))) as DbMessageRow[]);
        return rows.map(rowToMessage).reverse();
    }

    // INFRASTRUCTURE ----------------------------------------------------------

    /**
     * Wrap a write in a retry loop with random jitter. Breaks SQLite's busy-
     * handler convoy effect under concurrent writers. Returns the callback's
     * value so callers don't need out-of-band capture.
     *
     * Sleep between retries uses `Atomics.wait` on a SharedArrayBuffer-backed
     * Int32Array — the value is 0 and we wait for it to change, which never
     * happens, so every wait times out exactly at `jitter` ms. Unlike a busy
     * `while (Date.now() < until)` spin, this releases the CPU.
     */
    private runWrite<T>(fn: () => T): T {
        if (this.closed) {
            throw new Error('LearningStore: cannot write — database is closed');
        }
        let lastErr: unknown;
        for (let attempt = 0; attempt < WRITE_MAX_RETRIES; attempt++) {
            try {
                let result!: T;
                const trx = this.db.transaction(() => {
                    result = fn();
                });
                trx.immediate();
                this.onWrite();
                return result;
            } catch (err) {
                lastErr = err;
                const msg = err instanceof Error ? err.message : String(err);
                if (!msg.includes('SQLITE_BUSY') && !msg.includes('database is locked')) {
                    throw err;
                }
                const jitter =
                    WRITE_RETRY_MIN_MS + Math.random() * (WRITE_RETRY_MAX_MS - WRITE_RETRY_MIN_MS);
                Atomics.wait(this.retrySleepView, 0, 0, jitter);
            }
        }
        const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
        throw new Error(
            `LearningStore: write failed after ${WRITE_MAX_RETRIES} retries: ${detail}`,
        );
    }

    private onWrite(): void {
        this.writeCount++;
        if (this.writeCount % CHECKPOINT_EVERY_N_WRITES === 0) {
            try {
                this.db.pragma('wal_checkpoint(PASSIVE)');
            } catch (err) {
                log.debug({ err }, 'passive checkpoint failed (non-fatal)');
            }
        }
    }

    private applySchema(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
    `);

        const existing = this.db
            .prepare(`SELECT version FROM schema_version WHERE id = 1`)
            .get() as { version: number } | undefined;
        if (existing?.version === SCHEMA_VERSION) return;

        if (existing && existing.version < SCHEMA_VERSION) {
            log.warn(
                { currentVersion: existing.version, expectedVersion: SCHEMA_VERSION, path: this.dbPath },
                'state.db schema outdated — delete the file and restart to migrate (per-peer memory now lives in memory.db)',
            );
        }

        // No migrations — schema is a single canonical DDL block. When the
        // schema changes (new columns, new tables), bump SCHEMA_VERSION,
        // edit `applyInitialSchema`, and delete `state.db` once.
        this.applyInitialSchema();
        this.db
            .prepare(`INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)`)
            .run(SCHEMA_VERSION);
    }

    // background_tasks: durable mirror for spawn_background_task.

    /**
     * Insert a new background task row at spawn time. Throws on duplicate
     * `taskId` because TaskRegistry's monotonic id generator should never
     * produce a collision; if it does, that's a bug worth surfacing.
     */
    recordBackgroundTask(row: BackgroundTaskRow): void {
        this.db
            .prepare(
                `INSERT INTO background_tasks
                   (task_id, thread_id, worker_name, task_prompt, tool_allowlist,
                    timeout_ms, delivery_mode, status, created_at, ended_at,
                    result, error, description)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                row.taskId,
                row.threadId,
                row.workerName,
                row.taskPrompt,
                row.toolAllowlist ? JSON.stringify(row.toolAllowlist) : null,
                row.timeoutMs,
                row.deliveryMode,
                row.status,
                row.createdAt,
                row.endedAt,
                row.result,
                row.error,
                row.description,
            );
    }

    /**
     * Update an existing background task to its terminal (or near-terminal)
     * state. `running → completed | failed | killed`. The runner's success
     * path supplies `result`; failure paths supply `error`. Patch is partial
     * so we only touch the fields that changed.
     */
    updateBackgroundTaskStatus(
        taskId: string,
        patch: { status: BackgroundTaskStatus; result?: string; error?: string; endedAt?: number },
    ): void {
        const endedAt = patch.endedAt ?? Date.now();
        this.db
            .prepare(
                `UPDATE background_tasks
                    SET status = ?,
                        ended_at = COALESCE(?, ended_at),
                        result = COALESCE(?, result),
                        error = COALESCE(?, error)
                  WHERE task_id = ?`,
            )
            .run(
                patch.status,
                endedAt,
                patch.result ?? null,
                patch.error ?? null,
                taskId,
            );
    }

    /**
     * Mark a `completed` task as `delivered` once the channel-worker has
     * successfully run the task_complete turn and surfaced the result to the
     * user. This is the idempotency seal — the boot resume sweep skips
     * `delivered` rows so we never double-deliver after a restart.
     */
    markBackgroundTaskDelivered(taskId: string): void {
        this.db
            .prepare(
                `UPDATE background_tasks
                    SET status = 'delivered'
                  WHERE task_id = ? AND status = 'completed'`,
            )
            .run(taskId);
    }

    /**
     * Pull all background tasks for a thread that are in any of the requested
     * statuses, oldest first (resume order matters: we want to spawn the
     * oldest pending task first so it's not starved by newer ones).
     */
    listBackgroundTasksForThread(
        threadId: string,
        statuses: ReadonlyArray<BackgroundTaskStatus>,
    ): BackgroundTaskRow[] {
        if (statuses.length === 0) return [];
        const placeholders = statuses.map(() => '?').join(',');
        const rows = this.db
            .prepare(
                `SELECT task_id, thread_id, worker_name, task_prompt, tool_allowlist,
                        timeout_ms, delivery_mode, status, created_at, ended_at,
                        result, error, description
                   FROM background_tasks
                  WHERE thread_id = ? AND status IN (${placeholders})
                  ORDER BY created_at ASC`,
            )
            .all(threadId, ...statuses) as DbBackgroundTaskRow[];
        return rows.map(rowToBackgroundTask);
    }

    /**
     * Sweep `running` tasks older than `cutoffAgeMs` into `killed` status.
     * Called once at TeamHandler construction so we don't try to resume
     * tasks that were stranded for hours/days (likely orphaned by upstream
     * issues we can't recover from). Returns the number marked.
     */
    killStaleBackgroundTasks(cutoffAgeMs: number, now = Date.now()): number {
        const cutoff = now - cutoffAgeMs;
        const result = this.db
            .prepare(
                `UPDATE background_tasks
                    SET status = 'killed',
                        ended_at = ?,
                        error = COALESCE(error, 'stale on boot — exceeded ' || ? || 'ms')
                  WHERE status = 'running' AND created_at < ?`,
            )
            .run(now, cutoffAgeMs, cutoff);
        return result.changes;
    }

    private applyInitialSchema(): void {
        this.db.exec(`
      -- ── Peer + Session model ────────────────────────────────────────
      -- Permanent identity (peer) decoupled from bounded conversation
      -- (session). Resolves the "thread grows forever" problem.
      --
      -- peer_id format: <channel>:<scope>:<peer_native_id>
      --   e.g. telegram:dm:5257796557
      -- session_id format: s-<unix-day>-<short-hex>
      --   e.g. s-19834-4a7b9f1
      -- effective threadId for checkpointer = <peer_id>#<session_id>

      CREATE TABLE IF NOT EXISTS peers (
        peer_id           TEXT PRIMARY KEY,
        channel           TEXT NOT NULL,
        scope             TEXT NOT NULL,
        peer_native_id    TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        last_active_at    INTEGER NOT NULL,
        active_session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id            TEXT PRIMARY KEY,
        peer_id               TEXT NOT NULL,
        opened_at             INTEGER NOT NULL,
        closed_at             INTEGER,
        close_reason          TEXT,
        turn_count            INTEGER NOT NULL DEFAULT 0,
        last_user_message_at  INTEGER NOT NULL,
        source                TEXT NOT NULL DEFAULT 'user',
        summary               TEXT,
        active_personality    TEXT,
        branch_label          TEXT,
        parent_session_id     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_peer
        ON sessions(peer_id, opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_active
        ON sessions(peer_id) WHERE closed_at IS NULL;
      -- One label per peer — /branch name would be ambiguous otherwise.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_branch_label
        ON sessions(peer_id, branch_label) WHERE branch_label IS NOT NULL;

      -- ── Tool failure capture ────────────────────────────────────────
      -- Per-peer record of how often each (tool, error pattern) pair has
      -- failed. The harness injects the top N recent rows into the system
      -- prompt as <tool_quirks> so the agent learns "x_search 429s after
      -- 10 calls in an hour — switch to web_search" without anyone teaching
      -- it. PK is the (peer, tool, pattern) triple so repeats UPSERT into
      -- a single row with an incrementing count.
      CREATE TABLE IF NOT EXISTS tool_failures (
        peer_id       TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        error_pattern TEXT NOT NULL,
        count         INTEGER NOT NULL DEFAULT 1,
        first_seen    INTEGER NOT NULL,
        last_seen     INTEGER NOT NULL,
        PRIMARY KEY (peer_id, tool_name, error_pattern)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_failures_peer_recent
        ON tool_failures(peer_id, last_seen DESC);

      -- ── Token usage (per thread × day × model) ──────────────────────
      CREATE TABLE IF NOT EXISTS token_usage (
        thread_id  TEXT    NOT NULL,
        date       TEXT    NOT NULL,
        provider   TEXT    NOT NULL,
        model      TEXT    NOT NULL,
        input      INTEGER NOT NULL DEFAULT 0,
        output     INTEGER NOT NULL DEFAULT 0,
        calls      INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, date, provider, model)
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_thread_date
        ON token_usage(thread_id, date DESC);

      -- Conversation messages + FTS5 content index.
      -- Authoritative transcript (messages) + a contentless FTS5 virtual
      -- table that indexes only content and looks up the row via the
      -- shared rowid. Triggers keep them in sync.
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT    NOT NULL,
        thread_id  TEXT    NOT NULL,
        role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
        content    TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_user_time
        ON messages(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_time
        ON messages(thread_id, created_at);

      -- background_tasks: durable mirror of TaskRegistry in-memory state for
      -- spawn_background_task. Lets a detached worker run survive a gateway
      -- restart — on boot, the resume sweep walks this table, re-spawns
      -- "running" rows (workers pick up their own checkpoint thanks to Fix A
      -- deterministic child threadId), and re-pushes task_complete events
      -- for "completed" but-not-"delivered" rows.
      --
      -- State machine:
      --   running   → spawned, runner promise in flight (re-spawn on boot)
      --   completed → runner resolved with a result, NOT yet user-visible
      --                (re-push task_complete on next thread access)
      --   delivered → channel-worker successfully ran the task_complete turn
      --                (terminal, kept for /audit; pruned separately)
      --   failed    → runner threw a non-abort error (terminal)
      --   killed    → user/timeout aborted, OR resume sweep marked stale (>24h)
      --
      -- thread_id matches the gateway routing-key format used by TeamHandler
      -- (e.g. telegram:dm:5257796557#s-12). It is the lookup key for both
      -- per-thread fetches and the staleness sweep.
      CREATE TABLE IF NOT EXISTS background_tasks (
        task_id        TEXT    PRIMARY KEY,
        thread_id      TEXT    NOT NULL,
        worker_name    TEXT    NOT NULL,
        task_prompt    TEXT    NOT NULL,
        tool_allowlist TEXT,
        timeout_ms     INTEGER,
        delivery_mode  TEXT,
        status         TEXT    NOT NULL CHECK (status IN ('running','completed','delivered','failed','killed')),
        created_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        result         TEXT,
        error          TEXT,
        description    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bgtasks_status
        ON background_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_bgtasks_thread
        ON background_tasks(thread_id, status);
    `);

        // FTS5 virtual table + triggers run as separate statements so a
        // missing FTS5 module surfaces as a single, clear error rather than
        // poisoning the whole schema apply.
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                  content,
                  content='messages',
                  content_rowid='id',
                  tokenize='porter unicode61 remove_diacritics 2'
                );
                CREATE TRIGGER IF NOT EXISTS messages_ai
                  AFTER INSERT ON messages BEGIN
                    INSERT INTO messages_fts(rowid, content)
                      VALUES (new.id, new.content);
                  END;
                CREATE TRIGGER IF NOT EXISTS messages_ad
                  AFTER DELETE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, content)
                      VALUES('delete', old.id, old.content);
                  END;
            `);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('no such module: fts5')) {
                throw new Error(
                    'LearningStore: SQLite build is missing FTS5 module. ' +
                        'Rebuild better-sqlite3 with the default amalgamation ' +
                        '(it ships FTS5) or use Node 20+ prebuilt binaries.',
                );
            }
            throw err;
        }

        log.info('initial schema applied');
    }
}

// Peer + Session types (added in PR 4).

export interface PeerRow {
    peerId: string;
    channel: string;
    scope: string;
    peerNativeId: string;
    createdAt: number;
    lastActiveAt: number;
    activeSessionId: string | null;
}

export interface SessionRow {
    sessionId: string;
    peerId: string;
    openedAt: number;
    closedAt: number | null;
    closeReason: string | null;
    turnCount: number;
    lastUserMessageAt: number;
    source: SessionSource;
    /** AI-written 1-3 sentence recap of this session, generated when it closes. */
    summary: string | null;
    /** Name of the personality overlay active for this session (`null` = default voice). */
    activePersonality: string | null;
    /** User-chosen label set by `/branch <name>`. Unique per peer. Null for unlabeled sessions. */
    branchLabel: string | null;
    /** When this session was forked, the session it inherited messages from. Null for "main"/root sessions. */
    parentSessionId: string | null;
}

export type SessionCloseReason = 'idle' | 'daily' | 'length' | 'user' | 'migration';
export type SessionSource = 'user' | 'heartbeat' | 'cron' | 'webhook';

// Row → Model converters -----------------------------------------------------

function rowToMessage(r: DbMessageRow): MessageRow {
    return {
        id: r.id,
        userId: r.user_id,
        threadId: r.thread_id,
        role: r.role === 'assistant' ? 'assistant' : 'user',
        content: r.content,
        createdAt: r.created_at,
    };
}

function rowToBackgroundTask(r: DbBackgroundTaskRow): BackgroundTaskRow {
    let toolAllowlist: readonly string[] | null = null;
    if (r.tool_allowlist) {
        try {
            const parsed = JSON.parse(r.tool_allowlist);
            if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
                toolAllowlist = parsed;
            }
        } catch {
            // Malformed JSON in the DB shouldn't crash a resume sweep — fall
            // through with null. The worker will run with the default toolset.
        }
    }
    return {
        taskId: r.task_id,
        threadId: r.thread_id,
        workerName: r.worker_name,
        taskPrompt: r.task_prompt,
        toolAllowlist,
        timeoutMs: r.timeout_ms,
        deliveryMode: r.delivery_mode,
        status: r.status,
        createdAt: r.created_at,
        endedAt: r.ended_at,
        result: r.result,
        error: r.error,
        description: r.description,
    };
}

function rowToMessageSearchHit(r: DbMessageSearchRow): MessageSearchHit {
    return {
        id: r.id,
        userId: r.user_id,
        threadId: r.thread_id,
        role: r.role === 'assistant' ? 'assistant' : 'user',
        content: r.content,
        createdAt: r.created_at,
        rank: r.rank,
        snippet: r.snippet,
    };
}

/**
 * Make a user-supplied string safe to pass to FTS5's MATCH operator.
 *
 * FTS5 syntax treats a lot of punctuation as operators (AND, OR, NOT, NEAR,
 * ^, *, :, (, )). If the user is literally searching for `c++` or `what's`
 * the raw query would either throw a parse error or match the wrong thing.
 *
 * Strategy: if the trimmed query already looks like a phrase (starts with a
 * quote), contains an explicit prefix (trailing *), or contains FTS operator
 * keywords, pass it through. Otherwise tokenise on whitespace, strip non-word
 * chars per token, drop empties, and quote each token — giving us a safe
 * AND-of-literal-tokens match that matches user intent ~always.
 */
function sanitizeFtsQuery(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return '';

    // User is driving FTS syntax themselves — don't second-guess.
    const hasExplicitSyntax =
        trimmed.startsWith('"') ||
        /\*\s*$/.test(trimmed) ||
        /\b(AND|OR|NOT|NEAR)\b/.test(trimmed);
    if (hasExplicitSyntax) return trimmed;

    const tokens = trimmed
        .split(/\s+/)
        .map((t) => t.replace(/[^\p{L}\p{N}_]+/gu, ''))
        .filter((t) => t.length > 0);
    if (tokens.length === 0) return '';

    // Quote each token so FTS5 treats it as a literal.
    return tokens.map((t) => `"${t}"`).join(' ');
}

function rowToPeer(r: DbPeerRow): PeerRow {
    return {
        peerId: r.peer_id,
        channel: r.channel,
        scope: r.scope,
        peerNativeId: r.peer_native_id,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
        activeSessionId: r.active_session_id,
    };
}

function rowToSession(r: DbSessionRow): SessionRow {
    return {
        sessionId: r.session_id,
        peerId: r.peer_id,
        openedAt: r.opened_at,
        closedAt: r.closed_at,
        closeReason: r.close_reason,
        turnCount: r.turn_count,
        lastUserMessageAt: r.last_user_message_at,
        source: r.source as SessionSource,
        summary: r.summary ?? null,
        activePersonality: r.active_personality ?? null,
        branchLabel: r.branch_label ?? null,
        parentSessionId: r.parent_session_id ?? null,
    };
}

/**
 * Generate a sortable, explainable session id.
 *   s-<unix-day>-<short-hex>
 *   e.g. s-19834-4a7b9f1   ← day 19834 since epoch (≈ Apr 27 2026), random suffix
 *
 * Sortable means SELECT ... ORDER BY session_id naturally orders by date.
 * Suffix is 7 hex chars (28 bits) — collision-proof for any plausible
 * volume of sessions per day per peer.
 */
function generateSessionId(): string {
    const dayNum = Math.floor(Date.now() / 86_400_000);
    const suffix = Math.floor(Math.random() * 0xfffffff).toString(16).padStart(7, '0');
    return `s-${dayNum}-${suffix}`;
}

/**
 * Refuse to open a LearningStore outside the resolved Flopsy workspace.
 *
 * The ONE allowed root is whatever `resolveFlopsyHome()` resolves to —
 * honours `FLOPSY_HOME` (explicit override) and `FLOPSY_PROFILE`
 * (profile-suffixed home), otherwise defaults to `~/.flopsy`.
 *
 * To run the harness against a temporary location (tests, sandboxes) set
 * `FLOPSY_HOME=/tmp/my-test-dir` before constructing the store. Every file
 * the harness writes (state.db, checkpoints, skills, logs) will land there.
 */
function ensurePathInAllowedRoots(dbPath: string): void {
    const resolved = realpathParentOf(resolve(dbPath));
    const root = realpathParentOf(resolveFlopsyHome());
    const ok = resolved === root || resolved.startsWith(root + '/');
    if (!ok) {
        throw new Error(
            `LearningStore: refusing path "${resolved}" outside workspace root "${root}". ` +
                `Set FLOPSY_HOME to relocate the workspace.`,
        );
    }
}

/** Realpath a path's existing ancestor (tolerates a not-yet-created DB file). */
function realpathParentOf(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        const parent = dirname(p);
        if (parent === p) return p;
        try {
            return resolve(realpathSync(parent), p.slice(parent.length).replace(/^\/+/, ''));
        } catch {
            return p;
        }
    }
}

// Singleton (optional) -------------------------------------------------------

let sharedInstance: LearningStore | undefined;

export function getSharedLearningStore(): LearningStore {
    if (!sharedInstance) sharedInstance = new LearningStore();
    return sharedInstance;
}

export function closeSharedLearningStore(): void {
    sharedInstance?.close();
    sharedInstance = undefined;
}
