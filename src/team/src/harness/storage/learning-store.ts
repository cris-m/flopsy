import Database from 'better-sqlite3';
import { chmodSync, realpathSync } from 'fs';
import { dirname, resolve } from 'path';
import { createLogger, resolveFlopsyHome, resolveWorkspacePath, ensureDir } from '@flopsy/shared';

const log = createLogger('learning-store');

/** Current schema version. Bump when adding new tables or columns,
 *  AND add a corresponding entry to MIGRATIONS for the upgrade path. */
const SCHEMA_VERSION = 4;

/**
 * One ordered migration step. `fromVersion` is the schema version applied AGAINST.
 * Migrations run inside a single outer transaction (any throw rolls back the chain).
 * Use only idempotent DDL inside `up`.
 */
interface Migration {
    fromVersion: number;
    description: string;
    up: (db: Database.Database) => void;
}

const MIGRATIONS: ReadonlyArray<Migration> = [
    {
        fromVersion: 2,
        description: 'add background_tasks.kind to unify delegate/spawn telemetry',
        up: (db) => {
            db.exec(`ALTER TABLE background_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'spawn'`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_bgtasks_kind_created
                     ON background_tasks(kind, created_at)`);
        },
    },
    {
        fromVersion: 3,
        description: 'add session_goals for /goal Ralph-loop persistence',
        up: (db) => {
            db.exec(`
              CREATE TABLE IF NOT EXISTS session_goals (
                thread_id      TEXT    PRIMARY KEY,
                goal           TEXT    NOT NULL,
                status         TEXT    NOT NULL CHECK (status IN ('active','paused','done','cleared')),
                turns_used     INTEGER NOT NULL DEFAULT 0,
                max_turns      INTEGER NOT NULL DEFAULT 20,
                parse_failures INTEGER NOT NULL DEFAULT 0,
                created_at     INTEGER NOT NULL,
                last_turn_at   INTEGER NOT NULL,
                last_verdict   TEXT,
                last_reason    TEXT,
                channel_name   TEXT    NOT NULL,
                peer_id        TEXT    NOT NULL
              );
              CREATE INDEX IF NOT EXISTS idx_session_goals_active
                ON session_goals(status, last_turn_at);
            `);
        },
    },
];

/** Multi-process SQLite under WAL. */
const BUSY_TIMEOUT_MS = 1_000;
const WRITE_MAX_RETRIES = 15;
const WRITE_RETRY_MIN_MS = 20;
const WRITE_RETRY_MAX_MS = 150;
const CHECKPOINT_EVERY_N_WRITES = 50;

export interface ToolFailureRow {
    peerId: string;
    toolName: string;
    errorPattern: string;
    count: number;
    firstSeen: number;
    lastSeen: number;
}

// Raw DB row shapes mirror the DDL column names (snake_case) for compile-time drift detection.

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

/** Lifecycle states for a `spawn_background_task` row. */
export type BackgroundTaskStatus =
    | 'running'
    | 'completed'
    | 'delivered'
    | 'failed'
    | 'killed';

/** Discriminates synchronous delegate_task runs from async spawn_background_task runs. */
export type WorkerRunKind = 'spawn' | 'delegate';

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
    kind: WorkerRunKind;
}

export type GoalStatus = 'active' | 'paused' | 'done' | 'cleared';

export interface SessionGoalRow {
    threadId: string;
    goal: string;
    status: GoalStatus;
    turnsUsed: number;
    maxTurns: number;
    parseFailures: number;
    createdAt: number;
    lastTurnAt: number;
    lastVerdict: 'done' | 'continue' | 'skipped' | null;
    lastReason: string | null;
    channelName: string;
    peerId: string;
}

interface DbSessionGoalRow {
    thread_id: string;
    goal: string;
    status: GoalStatus;
    turns_used: number;
    max_turns: number;
    parse_failures: number;
    created_at: number;
    last_turn_at: number;
    last_verdict: 'done' | 'continue' | 'skipped' | null;
    last_reason: string | null;
    channel_name: string;
    peer_id: string;
}

/** Rolled-up activity for `flopsy team activity`. */
export interface WorkerActivityRow {
    workerName: string;
    totalCalls: number;
    delegateCalls: number;
    spawnCalls: number;
    completed: number;
    failed: number;
    killed: number;
    running: number;
    successRate: number;
    avgDurationMs: number;
    lastSeenMs: number;
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
    kind: WorkerRunKind;
}

/**
 * One row per proactive fire. Drives self-improve heartbeat anti-pattern detection.
 * `delivered` is tristate: 0 = suppressed, 1 = shipped, 2 = error.
 */
export interface ProactiveDecisionRow {
    peerId: string;
    jobId: string;
    jobName: string | null;
    triggerKind: 'cron' | 'heartbeat';
    firedAt: number;
    durationMs: number;
    deliveryMode: 'always' | 'conditional' | 'silent';
    delivered: 0 | 1 | 2;
    hasStructured: 0 | 1;
    category: string | null;
    silenceReason: string | null;
    confidence: number | null;
    /** Agent's justification (when structured.reason set). Truncated to 500ch. */
    reason: string | null;
    /** First 500ch of the delivered text, or empty when suppressed. */
    messagePreview: string | null;
    messageLen: number;
    /** Set later by markUserResponse when user replies on same channel within 60min. */
    userResponded: 0 | 1;
    responseAt: number | null;
}

/**
 * Inferred follow-up commitment. States: pending | delivered | dismissed | expired.
 * Always thread-bound; scope carries `agentId:channel:peerId`.
 */
export interface ProactiveCommitmentRow {
    /** SQLite auto-increment id. Required when surfacing — the agent
     * includes it in `reportedIds.commitments[]` to mark delivered. */
    id: number;
    peerId: string;
    /** Comma-joined `<agentId>:<channelName>:<peerId>` — the strict scope. */
    scope: string;
    channel: string;
    agentId: string;
    /** One-sentence check-in lead the proactive fire will surface. */
    followUp: string;
    dueAtMs: number;
    /** Extractor's confidence — only rows ≥ 0.7 should be recorded. */
    confidence: number;
    /** Optional thread/turn id the extractor pulled this from (for audit). */
    sourceTurnId: string | null;
    status: 'pending' | 'delivered' | 'dismissed' | 'expired';
    createdAt: number;
    /** When status flipped to delivered/dismissed/expired. */
    resolvedAt: number | null;
}

interface DbProactiveCommitmentRow {
    id: number;
    peer_id: string;
    scope: string;
    channel: string;
    agent_id: string;
    follow_up: string;
    due_at_ms: number;
    confidence: number;
    source_turn_id: string | null;
    status: 'pending' | 'delivered' | 'dismissed' | 'expired';
    created_at: number;
    resolved_at: number | null;
}

interface DbProactiveDecisionRow {
    id: number;
    peer_id: string;
    job_id: string;
    job_name: string | null;
    trigger_kind: 'cron' | 'heartbeat';
    fired_at: number;
    duration_ms: number;
    delivery_mode: 'always' | 'conditional' | 'silent';
    delivered: 0 | 1 | 2;
    has_structured: 0 | 1;
    category: string | null;
    silence_reason: string | null;
    confidence: number | null;
    reason: string | null;
    message_preview: string | null;
    message_len: number;
    user_responded: 0 | 1;
    response_at: number | null;
}

/**
 * LearningStore — SQLite backend for harness state (peers/sessions, tool failures,
 * token accounting, background tasks, proactive audit).
 * WAL with 1s busy_timeout; 15-retry write loop; PASSIVE checkpoint every 50 writes.
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
        // Force 0600 — better-sqlite3 inherits the process umask (typically 0644).
        try {
            chmodSync(this.dbPath, 0o600);
        } catch {
            /* best-effort */
        }
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
        this.db.pragma('synchronous = NORMAL');
        // Bound on-disk WAL growth (long-running gateways otherwise accumulate hundreds of MB).
        this.db.pragma('journal_size_limit = 67108864');
        this.db.pragma('wal_autocheckpoint = 1000');

        this.applySchema();
        // Always run — legacy cleanup must happen even when schema_version is current.
        this.dropLegacyMessageTables();
        // Idempotent additive tables (no SCHEMA_VERSION bump required).
        this.ensureProactiveDecisionsTable();
        this.ensureProactiveCommitmentsTable();
        log.info({ path: this.dbPath, version: SCHEMA_VERSION }, 'LearningStore ready');
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try {
            // TRUNCATE shrinks .wal on disk (PASSIVE doesn't).
            this.db.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
            /* best-effort */
        }
        this.db.close();
    }

    /**
     * Delete rows past retention windows for `token_usage`, `tool_failures`,
     * and `proactive_decisions`. Idempotent; returns deletion counts.
     */
    pruneOldRows(retention?: {
        tokenUsageMs?: number;
        toolFailuresMs?: number;
        proactiveDecisionsMs?: number;
    }): { tokenUsage: number; toolFailures: number; proactiveDecisions: number } {
        const now = Date.now();
        const cutoffTokenUsage = now - (retention?.tokenUsageMs ?? 90 * 24 * 60 * 60 * 1000);
        const cutoffToolFailures = now - (retention?.toolFailuresMs ?? 90 * 24 * 60 * 60 * 1000);
        const cutoffProactive = now - (retention?.proactiveDecisionsMs ?? 180 * 24 * 60 * 60 * 1000);

        const tokenUsage = this.db
            .prepare('DELETE FROM token_usage WHERE updated_at < ?')
            .run(cutoffTokenUsage).changes;
        const toolFailures = this.db
            .prepare('DELETE FROM tool_failures WHERE last_seen < ?')
            .run(cutoffToolFailures).changes;
        const proactiveDecisions = this.db
            .prepare('DELETE FROM proactive_decisions WHERE fired_at < ?')
            .run(cutoffProactive).changes;

        return { tokenUsage, toolFailures, proactiveDecisions };
    }

    /** Shared SQLite connection for satellite stores (PairingStore, etc.); never close. */
    getDatabase(): Database.Database {
        return this.db;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /** UPSERT on (peer, tool, pattern); empty pattern is a no-op. */
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

    /** Recent tool failures sorted by recency, ties broken by repeat count. */
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

    /** Insert peer if absent; refresh `last_active_at`. Does NOT create a session. */
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

    /** Opens + marks active. Caller closes the previous active session first. */
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
            // close source if still open
            this.db
                .prepare(
                    `UPDATE sessions
                     SET closed_at = ?, close_reason = 'user'
                     WHERE session_id = ? AND closed_at IS NULL`,
                )
                .run(now, input.srcSessionId);

            // open new session, labeled and parented
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

            // flip peer's active pointer
            this.db
                .prepare(`UPDATE peers SET active_session_id = ?, last_active_at = ? WHERE peer_id = ?`)
                .run(newSessionId, now, input.peerId);
        });

        const newRow = this.getSession(newSessionId);
        if (!newRow) throw new Error(`forkSession post-condition failed: ${newSessionId}`);
        return newRow;
    }

    /** Branch by (peer, label); works open or closed so `/branch switch` finds dormant branches. */
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

    /** Branches (labeled sessions) plus active-if-unlabeled, newest first. Powers `/branch list`. */
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
     * Switch active pointer to a forked branch: closes current, clears target's
     * `closed_at`. Returns reopened row or null when label unknown.
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

    /** null reverts to default voice. Powers `/personality`. */
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

    /** Most-recently-closed session with a non-empty summary. */
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

    /** Active = closed_at IS NULL AND peer.active_session_id matches. */
    getActiveSession(peerId: string): SessionRow | null {
        const peer = this.getPeer(peerId);
        if (!peer || !peer.activeSessionId) return null;
        const session = this.getSession(peer.activeSessionId);
        if (!session || session.closedAt !== null) return null;
        return session;
    }

    /** Bumps turn_count; user-source also bumps last_user_message_at (background can't keep dead sessions alive). */
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

    /** UPSERT on (thread, day, provider, model); caller computes `date` as local YYYY-MM-DD. */
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

    /** Aggregate turn count across this peer's sessions; one turn ≈ one user + one assistant. */
    getMessageCountForPeer(peerId: string, sinceMs: number): {
        total: number;
        user: number;
        assistant: number;
    } {
        const row = this.db
            .prepare(
                `SELECT COALESCE(SUM(turn_count), 0) AS turns
                   FROM sessions
                  WHERE peer_id = ?
                    AND COALESCE(last_user_message_at, opened_at) >= ?`,
            )
            .get(peerId, sinceMs) as { turns: number };
        const turns = row.turns ?? 0;
        // One turn ≈ one user message + one assistant reply.
        return { total: turns * 2, user: turns, assistant: turns };
    }

    /** Window stats + top-N longest sessions by turn_count. */
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

    /** Peer-scoped window totals by (provider, model). LIKE prefix covers all sessions. */
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

    /** Closed sessions with summary, newest first. */
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
     * Write with retry loop + random jitter to break SQLite busy-handler convoys.
     * Sleeps via `Atomics.wait` on a 0-valued SharedArrayBuffer (releases CPU vs spin).
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

        if (!existing) {
            this.applyInitialSchema();
            this.stampSchemaVersion(SCHEMA_VERSION);
            return;
        }

        if (existing.version === SCHEMA_VERSION) return;

        // Refuse downgrade — would silently overwrite the version stamp.
        if (existing.version > SCHEMA_VERSION) {
            throw new Error(
                `learning.db schema_version=${existing.version} is newer than supported ${SCHEMA_VERSION} (downgrade not allowed; path=${this.dbPath})`,
            );
        }

        // Single transaction so a partial migration never leaves an intermediate state.
        const upgradeTxn = this.db.transaction(() => {
            let v = existing.version;
            for (const m of MIGRATIONS) {
                if (m.fromVersion !== v) continue;
                if (v >= SCHEMA_VERSION) break;
                log.info(
                    { from: v, to: v + 1, description: m.description, path: this.dbPath },
                    'applying schema migration',
                );
                m.up(this.db);
                v += 1;
                this.stampSchemaVersion(v);
            }
            if (v !== SCHEMA_VERSION) {
                throw new Error(
                    `migration chain incomplete: reached v${v}, expected v${SCHEMA_VERSION} (path=${this.dbPath})`,
                );
            }
        });
        upgradeTxn();
    }

    private stampSchemaVersion(version: number): void {
        this.db
            .prepare(`INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)`)
            .run(version);
    }

    /** Insert at spawn time. Throws on duplicate `taskId` (TaskRegistry guarantees uniqueness). */
    recordBackgroundTask(row: BackgroundTaskRow): void {
        this.db
            .prepare(
                `INSERT INTO background_tasks
                   (task_id, thread_id, worker_name, task_prompt, tool_allowlist,
                    timeout_ms, delivery_mode, status, created_at, ended_at,
                    result, error, description, kind)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                row.kind,
            );
    }

    /** Record a delegate_task run (synchronous; terminal state on entry). */
    recordDelegateRun(args: {
        taskId: string;
        threadId: string;
        workerName: string;
        taskPrompt: string;
        toolAllowlist: readonly string[] | null;
        startedAtMs: number;
        endedAtMs: number;
        status: Exclude<BackgroundTaskStatus, 'running' | 'delivered'>;
        result: string | null;
        error: string | null;
    }): void {
        this.runWrite(() => {
            this.recordBackgroundTask({
                taskId: args.taskId,
                threadId: args.threadId,
                workerName: args.workerName,
                taskPrompt: args.taskPrompt,
                toolAllowlist: args.toolAllowlist,
                timeoutMs: null,
                deliveryMode: null,
                status: args.status,
                createdAt: args.startedAtMs,
                endedAt: args.endedAtMs,
                result: args.result,
                error: args.error,
                description: null,
                kind: 'delegate',
            });
        });
    }

    /** Roll up per-worker stats since `sinceMs`. Excludes ‘running’ from successRate
     *  denominator (in-flight rows have no outcome yet). */
    listWorkerActivity(args: {
        sinceMs: number;
        workerName?: string;
    }): readonly WorkerActivityRow[] {
        const params: (string | number)[] = [args.sinceMs];
        let where = `created_at >= ?`;
        if (args.workerName) {
            where += ` AND worker_name = ?`;
            params.push(args.workerName);
        }
        const rows = this.db
            .prepare(
                `SELECT
                   worker_name,
                   COUNT(*)                                                AS total,
                   SUM(CASE WHEN kind = 'delegate' THEN 1 ELSE 0 END)      AS delegate_calls,
                   SUM(CASE WHEN kind = 'spawn'    THEN 1 ELSE 0 END)      AS spawn_calls,
                   SUM(CASE WHEN status IN ('completed','delivered') THEN 1 ELSE 0 END) AS completed,
                   SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END)     AS failed,
                   SUM(CASE WHEN status = 'killed'  THEN 1 ELSE 0 END)     AS killed,
                   SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END)     AS running,
                   AVG(CASE WHEN ended_at IS NOT NULL THEN ended_at - created_at END) AS avg_duration,
                   MAX(created_at)                                         AS last_seen
                 FROM background_tasks
                 WHERE ${where}
                 GROUP BY worker_name
                 ORDER BY total DESC, worker_name ASC`,
            )
            .all(...params) as Array<{
                worker_name: string;
                total: number;
                delegate_calls: number;
                spawn_calls: number;
                completed: number;
                failed: number;
                killed: number;
                running: number;
                avg_duration: number | null;
                last_seen: number;
            }>;
        return rows.map((r) => {
            const terminal = r.completed + r.failed + r.killed;
            return {
                workerName: r.worker_name,
                totalCalls: r.total,
                delegateCalls: r.delegate_calls,
                spawnCalls: r.spawn_calls,
                completed: r.completed,
                failed: r.failed,
                killed: r.killed,
                running: r.running,
                successRate: terminal === 0 ? 0 : r.completed / terminal,
                avgDurationMs: Math.round(r.avg_duration ?? 0),
                lastSeenMs: r.last_seen,
            };
        });
    }

    getSessionGoal(threadId: string): SessionGoalRow | null {
        const row = this.db
            .prepare(`SELECT * FROM session_goals WHERE thread_id = ?`)
            .get(threadId) as DbSessionGoalRow | undefined;
        return row ? rowToSessionGoal(row) : null;
    }

    upsertSessionGoal(row: SessionGoalRow): void {
        this.runWrite(() => {
            this.db
                .prepare(
                    `INSERT INTO session_goals
                       (thread_id, goal, status, turns_used, max_turns,
                        parse_failures, created_at, last_turn_at,
                        last_verdict, last_reason, channel_name, peer_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(thread_id) DO UPDATE SET
                       goal           = excluded.goal,
                       status         = excluded.status,
                       turns_used     = excluded.turns_used,
                       max_turns      = excluded.max_turns,
                       parse_failures = excluded.parse_failures,
                       last_turn_at   = excluded.last_turn_at,
                       last_verdict   = excluded.last_verdict,
                       last_reason    = excluded.last_reason,
                       channel_name   = excluded.channel_name,
                       peer_id        = excluded.peer_id`,
                )
                .run(
                    row.threadId,
                    row.goal,
                    row.status,
                    row.turnsUsed,
                    row.maxTurns,
                    row.parseFailures,
                    row.createdAt,
                    row.lastTurnAt,
                    row.lastVerdict,
                    row.lastReason,
                    row.channelName,
                    row.peerId,
                );
        });
    }

    patchSessionGoal(
        threadId: string,
        patch: Partial<Pick<SessionGoalRow,
            'status' | 'turnsUsed' | 'parseFailures' | 'lastTurnAt' | 'lastVerdict' | 'lastReason'>>,
    ): void {
        const sets: string[] = [];
        const values: (string | number | null)[] = [];
        if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
        if (patch.turnsUsed !== undefined) { sets.push('turns_used = ?'); values.push(patch.turnsUsed); }
        if (patch.parseFailures !== undefined) { sets.push('parse_failures = ?'); values.push(patch.parseFailures); }
        if (patch.lastTurnAt !== undefined) { sets.push('last_turn_at = ?'); values.push(patch.lastTurnAt); }
        if (patch.lastVerdict !== undefined) { sets.push('last_verdict = ?'); values.push(patch.lastVerdict); }
        if (patch.lastReason !== undefined) { sets.push('last_reason = ?'); values.push(patch.lastReason); }
        if (sets.length === 0) return;
        this.runWrite(() => {
            this.db
                .prepare(`UPDATE session_goals SET ${sets.join(', ')} WHERE thread_id = ?`)
                .run(...values, threadId);
        });
    }

    deleteSessionGoal(threadId: string): void {
        this.runWrite(() => {
            this.db.prepare(`DELETE FROM session_goals WHERE thread_id = ?`).run(threadId);
        });
    }

    /** Transition `running → completed | failed | killed`; partial patch. */
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
     * Tasks for a thread in requested statuses, oldest first for fair resume order.
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
                        result, error, description, kind
                   FROM background_tasks
                  WHERE thread_id = ? AND status IN (${placeholders})
                  ORDER BY created_at ASC`,
            )
            .all(threadId, ...statuses) as DbBackgroundTaskRow[];
        return rows.map(rowToBackgroundTask);
    }

    /** Boot-time sweep: mark stuck `running` tasks as `killed`. Returns count touched. */
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

    // Idempotent additive table; not part of SCHEMA_VERSION (no forced state.db rebuilds).
    private ensureProactiveDecisionsTable(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS proactive_decisions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        peer_id         TEXT    NOT NULL,
        job_id          TEXT    NOT NULL,
        job_name        TEXT,
        trigger_kind    TEXT    NOT NULL,
        fired_at        INTEGER NOT NULL,
        duration_ms     INTEGER NOT NULL,
        delivery_mode   TEXT    NOT NULL,
        delivered       INTEGER NOT NULL,
        has_structured  INTEGER NOT NULL DEFAULT 0,
        category        TEXT,
        silence_reason  TEXT,
        confidence      REAL,
        reason          TEXT,
        message_preview TEXT,
        message_len     INTEGER NOT NULL DEFAULT 0,
        user_responded  INTEGER NOT NULL DEFAULT 0,
        response_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pd_peer_fired
        ON proactive_decisions(peer_id, fired_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pd_job_fired
        ON proactive_decisions(job_id, fired_at DESC);
    `);
    }

    /** Separate from proactive_decisions; commitments have their own lifecycle. */
    private ensureProactiveCommitmentsTable(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS proactive_commitments (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        peer_id         TEXT    NOT NULL,
        scope           TEXT    NOT NULL,
        channel         TEXT    NOT NULL,
        agent_id        TEXT    NOT NULL,
        follow_up       TEXT    NOT NULL,
        due_at_ms       INTEGER NOT NULL,
        confidence      REAL    NOT NULL,
        source_turn_id  TEXT,
        status          TEXT    NOT NULL DEFAULT 'pending',
        created_at      INTEGER NOT NULL,
        resolved_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pc_due
        ON proactive_commitments(status, due_at_ms);
      CREATE INDEX IF NOT EXISTS idx_pc_scope_due
        ON proactive_commitments(scope, status, due_at_ms);
      CREATE INDEX IF NOT EXISTS idx_pc_peer_created
        ON proactive_commitments(peer_id, created_at DESC);
    `);
    }

    /** Best-effort insert; returns auto-increment id. */
    recordCommitment(
        row: Omit<ProactiveCommitmentRow, 'id' | 'createdAt' | 'resolvedAt' | 'status'> & {
            createdAt?: number;
            status?: ProactiveCommitmentRow['status'];
        },
    ): number {
        const createdAt = row.createdAt ?? Date.now();
        const status: ProactiveCommitmentRow['status'] = row.status ?? 'pending';
        const result = this.db
            .prepare(
                `INSERT INTO proactive_commitments
                   (peer_id, scope, channel, agent_id, follow_up,
                    due_at_ms, confidence, source_turn_id, status,
                    created_at, resolved_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
            )
            .run(
                row.peerId,
                row.scope,
                row.channel,
                row.agentId,
                row.followUp,
                row.dueAtMs,
                row.confidence,
                row.sourceTurnId ?? null,
                status,
                createdAt,
            );
        this.onWrite();
        return Number(result.lastInsertRowid);
    }

    /** Read by `peer_id` (channel-agnostic) so commitments surface regardless of fire channel. */
    listDueCommitments(peerId: string, nowMs: number, limit = 5): ProactiveCommitmentRow[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM proactive_commitments
                  WHERE peer_id = ?
                    AND status = 'pending'
                    AND due_at_ms <= ?
                  ORDER BY due_at_ms ASC
                  LIMIT ?`,
            )
            .all(peerId, nowMs, limit) as DbProactiveCommitmentRow[];
        return rows.map((r) => ({
            id: r.id,
            peerId: r.peer_id,
            scope: r.scope,
            channel: r.channel,
            agentId: r.agent_id,
            followUp: r.follow_up,
            dueAtMs: r.due_at_ms,
            confidence: r.confidence,
            sourceTurnId: r.source_turn_id,
            status: r.status,
            createdAt: r.created_at,
            resolvedAt: r.resolved_at,
        }));
    }

    /** Flip status. Used by the executor and `flopsy commitments dismiss`. */
    resolveCommitment(
        id: number,
        status: 'delivered' | 'dismissed' | 'expired',
        nowMs = Date.now(),
    ): boolean {
        const result = this.db
            .prepare(
                `UPDATE proactive_commitments
                    SET status = ?, resolved_at = ?
                  WHERE id = ? AND status = 'pending'`,
            )
            .run(status, nowMs, id);
        if (result.changes > 0) this.onWrite();
        return result.changes > 0;
    }

    /** Daily-budget guard for the extractor. Counts pending+delivered only. */
    countCommitmentsCreatedSince(peerId: string, sinceMs: number): number {
        const row = this.db
            .prepare(
                `SELECT COUNT(*) as n FROM proactive_commitments
                  WHERE peer_id = ?
                    AND created_at >= ?
                    AND status IN ('pending', 'delivered')`,
            )
            .get(peerId, sinceMs) as { n: number } | undefined;
        return row?.n ?? 0;
    }

    /** Operator-facing list — used by `flopsy commitments list` CLI. */
    listCommitmentsForPeer(peerId: string, limit = 20): ProactiveCommitmentRow[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM proactive_commitments
                  WHERE peer_id = ?
                  ORDER BY created_at DESC
                  LIMIT ?`,
            )
            .all(peerId, limit) as DbProactiveCommitmentRow[];
        return rows.map((r) => ({
            id: r.id,
            peerId: r.peer_id,
            scope: r.scope,
            channel: r.channel,
            agentId: r.agent_id,
            followUp: r.follow_up,
            dueAtMs: r.due_at_ms,
            confidence: r.confidence,
            sourceTurnId: r.source_turn_id,
            status: r.status,
            createdAt: r.created_at,
            resolvedAt: r.resolved_at,
        }));
    }

    clearToolFailuresFor(peerId: string, toolName: string): number {
        let changes = 0;
        this.runWrite(() => {
            changes = this.db
                .prepare('DELETE FROM tool_failures WHERE peer_id = ? AND tool_name = ?')
                .run(peerId, toolName).changes;
        });
        return changes;
    }

    listRecentDismissedFollowUps(
        peerId: string,
        options: { limit?: number; windowMs?: number } = {},
    ): ReadonlyArray<{ followUp: string; resolvedAt: number | null }> {
        const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
        const windowMs = options.windowMs ?? 30 * 24 * 60 * 60 * 1000;
        const since = Date.now() - windowMs;
        const rows = this.db
            .prepare(
                `SELECT follow_up, resolved_at
                   FROM proactive_commitments
                  WHERE peer_id = ?
                    AND status = 'dismissed'
                    AND coalesce(resolved_at, created_at) >= ?
                  ORDER BY coalesce(resolved_at, created_at) DESC
                  LIMIT ?`,
            )
            .all(peerId, since, limit) as Array<{ follow_up: string; resolved_at: number | null }>;
        return rows.map((r) => ({ followUp: r.follow_up, resolvedAt: r.resolved_at }));
    }

    /** Insert one row per fire. Best-effort — callers should swallow errors. */
    recordProactiveDecision(row: ProactiveDecisionRow): void {
        this.db
            .prepare(
                `INSERT INTO proactive_decisions
                   (peer_id, job_id, job_name, trigger_kind, fired_at,
                    duration_ms, delivery_mode, delivered, has_structured,
                    category, silence_reason, confidence, reason,
                    message_preview, message_len, user_responded, response_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                row.peerId,
                row.jobId,
                row.jobName,
                row.triggerKind,
                row.firedAt,
                row.durationMs,
                row.deliveryMode,
                row.delivered,
                row.hasStructured,
                row.category,
                row.silenceReason,
                row.confidence,
                row.reason,
                row.messagePreview,
                row.messageLen,
                row.userResponded,
                row.responseAt,
            );
        this.onWrite();
    }

    /** Correlate user reply within `windowMs` of delivered fire. Returns rows touched. */
    markUserResponse(peerId: string, now: number, windowMs: number): number {
        const since = now - windowMs;
        const result = this.db
            .prepare(
                `UPDATE proactive_decisions
                    SET user_responded = 1,
                        response_at    = ?
                  WHERE peer_id        = ?
                    AND response_at    IS NULL
                    AND delivered      = 1
                    AND fired_at       >= ?`,
            )
            .run(now, peerId, since);
        if (result.changes > 0) this.onWrite();
        return result.changes;
    }

    /**
     * Pull recent rows for the self-improve heartbeat's `<proactive_self_review>`
     * block. Caller passes a window in ms (e.g. 24h) and a row cap. Newest
     * first — the block builder slices by anti-pattern from there.
     */
    getRecentProactiveDecisions(
        peerId: string,
        windowMs: number,
        limit: number,
    ): ProactiveDecisionRow[] {
        const since = Date.now() - windowMs;
        const rows = this.db
            .prepare(
                `SELECT * FROM proactive_decisions
                  WHERE peer_id = ? AND fired_at >= ?
                  ORDER BY fired_at DESC
                  LIMIT ?`,
            )
            .all(peerId, since, limit) as DbProactiveDecisionRow[];
        return rows.map(rowToProactiveDecision);
    }

    private applyInitialSchema(): void {
        this.db.exec(`
      -- ── Peer + Session model ────────────────────────────────────────
      -- Permanent identity (peer) decoupled from bounded conversation
      -- (session). Resolves the "thread grows forever" problem.
      --
      -- peer_id format: <channel>:<scope>:<peer_native_id>
      --   e.g. telegram:dm:123456789
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

      -- Tool failure capture: harness injects top N rows as <tool_quirks>.
      -- PK is (peer, tool, pattern); repeats UPSERT count.
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

      -- background_tasks: durable TaskRegistry mirror for spawn_background_task.
      -- States: running → completed | delivered | failed | killed.
      -- background_tasks: unified worker-run ledger for delegate_task (sync, kind='delegate')
      -- and spawn_background_task (async, kind='spawn'). States:
      --   delegate: completed | failed | killed (no 'running' window persisted)
      --   spawn:    running → completed | delivered | failed | killed
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
        description    TEXT,
        kind           TEXT    NOT NULL DEFAULT 'spawn' CHECK (kind IN ('spawn','delegate'))
      );
      CREATE INDEX IF NOT EXISTS idx_bgtasks_status
        ON background_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_bgtasks_thread
        ON background_tasks(thread_id, status);
      CREATE INDEX IF NOT EXISTS idx_bgtasks_kind_created
        ON background_tasks(kind, created_at);

      CREATE TABLE IF NOT EXISTS session_goals (
        thread_id      TEXT    PRIMARY KEY,
        goal           TEXT    NOT NULL,
        status         TEXT    NOT NULL CHECK (status IN ('active','paused','done','cleared')),
        turns_used     INTEGER NOT NULL DEFAULT 0,
        max_turns      INTEGER NOT NULL DEFAULT 20,
        parse_failures INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        last_turn_at   INTEGER NOT NULL,
        last_verdict   TEXT,
        last_reason    TEXT,
        channel_name   TEXT    NOT NULL,
        peer_id        TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_goals_active
        ON session_goals(status, last_turn_at);
    `);

        log.info('initial schema applied');
    }

    /** Drop legacy messages/FTS tables + triggers. Idempotent. */
    private dropLegacyMessageTables(): void {
        const stmts = [
            'DROP TRIGGER IF EXISTS messages_ai',
            'DROP TRIGGER IF EXISTS messages_ad',
            'DROP TABLE IF EXISTS messages_fts',
            'DROP TABLE IF EXISTS messages',
        ];
        for (const sql of stmts) {
            try {
                this.db.prepare(sql).run();
            } catch (err) {
                log.debug(
                    { sql, err: err instanceof Error ? err.message : String(err) },
                    'legacy messages table cleanup statement failed (non-fatal)',
                );
            }
        }
    }
}

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

function rowToBackgroundTask(r: DbBackgroundTaskRow): BackgroundTaskRow {
    let toolAllowlist: readonly string[] | null = null;
    if (r.tool_allowlist) {
        try {
            const parsed = JSON.parse(r.tool_allowlist);
            if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
                toolAllowlist = parsed;
            }
        } catch {
            // Malformed JSON shouldn't crash resume; worker runs with default toolset.
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
        kind: r.kind,
    };
}

function rowToSessionGoal(r: DbSessionGoalRow): SessionGoalRow {
    return {
        threadId: r.thread_id,
        goal: r.goal,
        status: r.status,
        turnsUsed: r.turns_used,
        maxTurns: r.max_turns,
        parseFailures: r.parse_failures,
        createdAt: r.created_at,
        lastTurnAt: r.last_turn_at,
        lastVerdict: r.last_verdict,
        lastReason: r.last_reason,
        channelName: r.channel_name,
        peerId: r.peer_id,
    };
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

function rowToProactiveDecision(r: DbProactiveDecisionRow): ProactiveDecisionRow {
    return {
        peerId: r.peer_id,
        jobId: r.job_id,
        jobName: r.job_name,
        triggerKind: r.trigger_kind,
        firedAt: r.fired_at,
        durationMs: r.duration_ms,
        deliveryMode: r.delivery_mode,
        delivered: r.delivered,
        hasStructured: r.has_structured,
        category: r.category,
        silenceReason: r.silence_reason,
        confidence: r.confidence,
        reason: r.reason,
        messagePreview: r.message_preview,
        messageLen: r.message_len,
        userResponded: r.user_responded,
        responseAt: r.response_at,
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

/** Sortable id `s-<unix-day>-<7-hex>` (ORDER BY session_id naturally orders by date). */
function generateSessionId(): string {
    const dayNum = Math.floor(Date.now() / 86_400_000);
    const suffix = Math.floor(Math.random() * 0xfffffff).toString(16).padStart(7, '0');
    return `s-${dayNum}-${suffix}`;
}

/** Refuse to open outside the resolved Flopsy workspace (FLOPSY_HOME / ~/.flopsy). */
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
