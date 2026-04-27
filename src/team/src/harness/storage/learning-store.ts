import Database from 'better-sqlite3';
import { realpathSync } from 'fs';
import { dirname, resolve } from 'path';
import { createLogger, resolveFlopsyHome, resolveWorkspacePath, ensureDir } from '@flopsy/shared';
import type { Strategy, Lesson } from '@shared/types';

const log = createLogger('learning-store');

/** Current schema version. Bump when adding new tables or columns. */
const SCHEMA_VERSION = 3;

/** Concurrency tuning — mirrors Hermes' proven pattern for multi-process SQLite. */
const BUSY_TIMEOUT_MS = 1_000;
const WRITE_MAX_RETRIES = 15;
const WRITE_RETRY_MIN_MS = 20;
const WRITE_RETRY_MAX_MS = 150;
const CHECKPOINT_EVERY_N_WRITES = 50;

export interface SkillEffectivenessEntry {
    effectiveness: number;
    successRate: number;
    useCount: number;
    successCount: number;
    failureCount: number;
    lastUsed: number;
    lastUpdated: number;
    tags: string[];
}

export interface FactRow {
    id: string;
    userId: string;
    subject: string;
    predicate: string;
    object: string;
    validityStart: number;
    validityEnd: number | null;
    confidence: number;
    source: string;
}

// ---------------------------------------------------------------------------
// Raw DB row shapes — mirror the DDL column names (snake_case).
// These live next to the queries so drift shows up at compile time.
// ---------------------------------------------------------------------------

interface DbStrategyRow {
    id: string;
    user_id: string;
    name: string;
    description: string | null;
    domain: string | null;
    effectiveness: number;
    uses: number;
    last_used: number;
    created_at: number;
    refinements: number;
    linked_skill_id: string | null;
    tags: string;
}

interface DbLessonRow {
    id: string;
    user_id: string;
    rule: string;
    reason: string | null;
    domain: string | null;
    severity: string;
    recorded_at: number;
    prevention_count: number;
    applies_to: string;
    example_mistake: string | null;
    correction: string | null;
    tags: string;
}

interface DbSkillMetaRow {
    user_id: string;
    skill_name: string;
    effectiveness: number;
    success_rate: number;
    use_count: number;
    success_count: number;
    failure_count: number;
    last_used: number;
    last_updated: number;
    tags: string;
}

interface DbFactRow {
    id: string;
    user_id: string;
    subject: string;
    predicate: string;
    object: string;
    validity_start: number;
    validity_end: number | null;
    confidence: number;
    source: string;
}

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
}

interface DbTopSkillRow {
    name: string;
    effectiveness: number;
    successRate: number;
}

interface DbEffectivenessRow {
    effectiveness: number;
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

interface DbMessageSearchRow extends DbMessageRow {
    rank: number;
    snippet: string;
}

/**
 * LearningStore — unified SQLite backend for the harness.
 *
 * Stores:
 *   - LEARNING state: strategies, lessons, skill effectiveness, facts
 *   - TOKEN accounting: per-(thread, day, provider, model) buckets
 *   - MESSAGES: user+assistant turns with an FTS5 index for session search
 *     (the agent's `search_past_conversations` tool reads this to answer
 *     "did I mention X last week?"). Only final-turn messages are persisted
 *     — intermediate tool loops stay in flopsygraph's checkpoint store.
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
    /**
     * Backing buffer for Atomics.wait — sleeps the thread without event-loop
     * blocking. Allocated once, zero-initialised, never written to (we only
     * read a value that never matches, so wait always times out).
     */
    private readonly retrySleepView: Int32Array = new Int32Array(
        new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    );

    constructor(dbPath?: string) {
        // Default: <workspace-root>/harness/state.db (FLOPSY_HOME-aware).
        this.dbPath = dbPath ?? resolveWorkspacePath('harness', 'state.db');
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

    get isClosed(): boolean {
        return this.closed;
    }

    // STRATEGIES --------------------------------------------------------------

    createStrategy(userId: string, strategy: Omit<Strategy, 'id'> & { id?: string }): Strategy {
        const id =
            strategy.id ?? `strategy_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const full: Strategy = { ...strategy, id } as Strategy;

        this.runWrite(() => {
            this.db
                .prepare(
                    `INSERT OR REPLACE INTO strategies
            (id, user_id, name, description, domain, effectiveness, uses, last_used, created_at, refinements, linked_skill_id, tags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    full.id,
                    userId,
                    full.name,
                    full.description,
                    full.domain ?? null,
                    full.effectiveness,
                    full.uses,
                    full.lastUsed,
                    full.createdAt,
                    full.refinements,
                    full.linkedSkillId ?? null,
                    JSON.stringify(full.tags ?? []),
                );
        });

        return full;
    }

    getStrategy(id: string): Strategy | null {
        const row = this.db.prepare(`SELECT * FROM strategies WHERE id = ?`).get(id) as
            | DbStrategyRow
            | undefined;
        return row ? rowToStrategy(row) : null;
    }

    getStrategiesForUser(userId: string): Strategy[] {
        const rows = this.db
            .prepare(`SELECT * FROM strategies WHERE user_id = ? ORDER BY effectiveness DESC`)
            .all(userId) as DbStrategyRow[];
        return rows.map(rowToStrategy);
    }

    getTopStrategiesByEffectiveness(userId: string, limit = 5): Strategy[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM strategies WHERE user_id = ? ORDER BY effectiveness DESC LIMIT ?`,
            )
            .all(userId, limit) as DbStrategyRow[];
        return rows.map(rowToStrategy);
    }

    getStrategiesByDomain(userId: string, domain: string): Strategy[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM strategies WHERE user_id = ? AND domain = ? ORDER BY effectiveness DESC`,
            )
            .all(userId, domain) as DbStrategyRow[];
        return rows.map(rowToStrategy);
    }

    updateStrategyEffectiveness(id: string, signalStrength: number): void {
        this.runWrite(() => {
            this.applyEffectivenessDelta(id, signalStrength);
        });
    }

    /**
     * Apply multiple effectiveness updates in one transaction. Preferred over
     * repeated `updateStrategyEffectiveness` calls from tight loops — avoids
     * N separate BEGIN IMMEDIATE/COMMIT cycles.
     */
    batchUpdateStrategyEffectiveness(
        updates: ReadonlyArray<{ id: string; signalStrength: number }>,
    ): void {
        if (updates.length === 0) return;
        this.runWrite(() => {
            for (const u of updates) this.applyEffectivenessDelta(u.id, u.signalStrength);
        });
    }

    /** Caller must already be inside a runWrite transaction. */
    private applyEffectivenessDelta(id: string, signalStrength: number): void {
        const row = this.db.prepare(`SELECT effectiveness FROM strategies WHERE id = ?`).get(id) as
            | DbEffectivenessRow
            | undefined;
        if (!row) return;

        const boosted = row.effectiveness * (1 + signalStrength * 0.1);
        const clamped = Math.max(0.2, Math.min(1.0, boosted));

        this.db
            .prepare(
                `UPDATE strategies
            SET effectiveness = ?, uses = uses + 1, last_used = ?, refinements = refinements + 1
          WHERE id = ?`,
            )
            .run(clamped, Date.now(), id);
    }

    deleteStrategy(id: string): void {
        this.runWrite(() => {
            this.db.prepare(`DELETE FROM strategies WHERE id = ?`).run(id);
        });
    }

    // LESSONS -----------------------------------------------------------------

    createLesson(userId: string, lesson: Omit<Lesson, 'id'> & { id?: string }): Lesson {
        const id = lesson.id ?? `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const full: Lesson = { ...lesson, id } as Lesson;

        this.runWrite(() => {
            this.db
                .prepare(
                    `INSERT OR REPLACE INTO lessons
            (id, user_id, rule, reason, domain, severity, recorded_at, prevention_count, applies_to, example_mistake, correction, tags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    full.id,
                    userId,
                    full.rule,
                    full.reason,
                    full.domain ?? null,
                    full.severity,
                    full.recordedAt,
                    full.preventionCount ?? 0,
                    full.appliesTo,
                    full.exampleMistake ?? null,
                    full.correction ?? null,
                    JSON.stringify(full.tags ?? []),
                );
        });

        return full;
    }

    getLessonsForUser(userId: string): Lesson[] {
        const rows = this.db
            .prepare(`SELECT * FROM lessons WHERE user_id = ? ORDER BY recorded_at DESC`)
            .all(userId) as DbLessonRow[];
        return rows.map(rowToLesson);
    }

    getLessonsByDomain(userId: string, domain: string): Lesson[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM lessons WHERE user_id = ? AND domain = ? ORDER BY recorded_at DESC`,
            )
            .all(userId, domain) as DbLessonRow[];
        return rows.map(rowToLesson);
    }

    findLessonByRule(userId: string, rule: string): Lesson | null {
        const row = this.db
            .prepare(`SELECT * FROM lessons WHERE user_id = ? AND rule = ?`)
            .get(userId, rule) as DbLessonRow | undefined;
        return row ? rowToLesson(row) : null;
    }

    // SKILL EFFECTIVENESS -----------------------------------------------------

    getSkillMeta(userId: string, skillName: string): SkillEffectivenessEntry | null {
        const row = this.db
            .prepare(`SELECT * FROM skills_meta WHERE user_id = ? AND skill_name = ?`)
            .get(userId, skillName) as DbSkillMetaRow | undefined;
        return row ? rowToSkillMeta(row) : null;
    }

    initSkillMeta(userId: string, skillName: string, domain?: string): SkillEffectivenessEntry {
        const existing = this.getSkillMeta(userId, skillName);
        if (existing) return existing;

        const entry: SkillEffectivenessEntry = {
            effectiveness: 0.5,
            successRate: 0.5,
            useCount: 0,
            successCount: 0,
            failureCount: 0,
            lastUsed: 0,
            lastUpdated: Date.now(),
            tags: domain ? [domain] : [],
        };

        this.runWrite(() => {
            this.db
                .prepare(
                    `INSERT INTO skills_meta
            (user_id, skill_name, effectiveness, success_rate, use_count, success_count, failure_count, last_used, last_updated, tags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    userId,
                    skillName,
                    entry.effectiveness,
                    entry.successRate,
                    entry.useCount,
                    entry.successCount,
                    entry.failureCount,
                    entry.lastUsed,
                    entry.lastUpdated,
                    JSON.stringify(entry.tags),
                );
        });

        return entry;
    }

    /**
     * Exponential smoothing: new = old * 0.7 + signalBased * 0.3, clamped [0.2, 1.0].
     */
    updateSkillMeta(
        userId: string,
        skillName: string,
        signalStrength: number,
    ): SkillEffectivenessEntry {
        return this.runWrite(() => {
            const entry =
                this.getSkillMeta(userId, skillName) ?? this.initSkillMeta(userId, skillName);

            const isSuccess = signalStrength >= 0;
            const useCount = entry.useCount + 1;
            const successCount = entry.successCount + (isSuccess ? 1 : 0);
            const failureCount = entry.failureCount + (isSuccess ? 0 : 1);
            const successRate = successCount / useCount;

            const signalBased = Math.max(0, Math.min(1, 0.5 + signalStrength * 0.1));
            const effectiveness = Math.max(
                0.2,
                Math.min(1.0, entry.effectiveness * 0.7 + signalBased * 0.3),
            );

            const now = Date.now();

            this.db
                .prepare(
                    `UPDATE skills_meta
              SET effectiveness = ?, success_rate = ?, use_count = ?,
                  success_count = ?, failure_count = ?, last_used = ?, last_updated = ?
            WHERE user_id = ? AND skill_name = ?`,
                )
                .run(
                    effectiveness,
                    successRate,
                    useCount,
                    successCount,
                    failureCount,
                    now,
                    now,
                    userId,
                    skillName,
                );

            return {
                ...entry,
                effectiveness,
                successRate,
                useCount,
                successCount,
                failureCount,
                lastUsed: now,
                lastUpdated: now,
            };
        });
    }

    getTopSkills(
        userId: string,
        limit = 5,
    ): Array<{ name: string; effectiveness: number; successRate: number }> {
        return this.db
            .prepare(
                `SELECT skill_name AS name, effectiveness, success_rate AS successRate
           FROM skills_meta
          WHERE user_id = ?
          ORDER BY effectiveness DESC
          LIMIT ?`,
            )
            .all(userId, limit) as DbTopSkillRow[];
    }

    getSkillsByDomain(
        userId: string,
        domain: string,
    ): Array<{ name: string; entry: SkillEffectivenessEntry }> {
        const rows = this.db
            .prepare(`SELECT * FROM skills_meta WHERE user_id = ?`)
            .all(userId) as DbSkillMetaRow[];
        return rows
            .map((r) => ({ name: r.skill_name, entry: rowToSkillMeta(r) }))
            .filter((s) => s.entry.tags.includes(domain));
    }

    // FACTS (bi-temporal) -----------------------------------------------------
    //
    // Structured long-term memory: (subject, predicate, object) tuples with
    // validity windows. Conversation messages live in the `messages` table
    // below with an FTS5 index; facts are the distilled form of what the
    // agent learned from those conversations.

    recordFact(fact: Omit<FactRow, 'id'> & { id?: string }): FactRow {
        const id = fact.id ?? `fact_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const row: FactRow = { ...fact, id };

        this.runWrite(() => {
            this.db
                .prepare(
                    `UPDATE facts SET validity_end = ?
            WHERE user_id = ? AND subject = ? AND predicate = ? AND validity_end IS NULL`,
                )
                .run(row.validityStart, row.userId, row.subject, row.predicate);

            this.db
                .prepare(
                    `INSERT INTO facts
            (id, user_id, subject, predicate, object, validity_start, validity_end, confidence, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    row.id,
                    row.userId,
                    row.subject,
                    row.predicate,
                    row.object,
                    row.validityStart,
                    row.validityEnd,
                    row.confidence,
                    row.source,
                );
        });

        return row;
    }

    retireFact(id: string, validityEnd: number = Date.now()): void {
        this.runWrite(() => {
            this.db
                .prepare(`UPDATE facts SET validity_end = ? WHERE id = ? AND validity_end IS NULL`)
                .run(validityEnd, id);
        });
    }

    getCurrentFacts(userId: string, subject?: string): FactRow[] {
        const rows = subject
            ? (this.db
                  .prepare(
                      `SELECT * FROM facts WHERE user_id = ? AND subject = ? AND validity_end IS NULL`,
                  )
                  .all(userId, subject) as DbFactRow[])
            : (this.db
                  .prepare(`SELECT * FROM facts WHERE user_id = ? AND validity_end IS NULL`)
                  .all(userId) as DbFactRow[]);
        return rows.map(rowToFact);
    }

    // PEERS + SESSIONS (PR 4) -------------------------------------------------

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
                     (session_id, peer_id, opened_at, closed_at, close_reason, turn_count, last_user_message_at, source)
                     VALUES (?, ?, ?, NULL, NULL, 0, ?, ?)`,
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

    // TOKEN USAGE -------------------------------------------------------------

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

    // MESSAGES + SESSION SEARCH ----------------------------------------------

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
        const currentVersion = existing?.version ?? 0;

        if (currentVersion === 0) {
            this.applyInitialSchema();
            this.applyTokenUsageSchema(); // v2
            this.applyMessagesSchema(); // v3
            this.db
                .prepare(`INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)`)
                .run(SCHEMA_VERSION);
            return;
        }

        // Forward migrations. Each block: run DDL, bump version. Idempotent —
        // CREATE TABLE IF NOT EXISTS so re-run after a crash is safe.
        if (currentVersion < 2) {
            this.applyTokenUsageSchema();
            this.db
                .prepare(`INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)`)
                .run(2);
        }
        if (currentVersion < 3) {
            this.applyMessagesSchema();
            this.db
                .prepare(`INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)`)
                .run(3);
        }
    }

    /**
     * v2 migration: per-thread x per-day x per-model token accounting.
     * Composite PK (thread_id, date, provider, model) gives us UPSERT
     * semantics - one row per unique combo, accumulated in place.
     */
    private applyTokenUsageSchema(): void {
        const ddl = [
            `CREATE TABLE IF NOT EXISTS token_usage (
                thread_id  TEXT    NOT NULL,
                date       TEXT    NOT NULL,
                provider   TEXT    NOT NULL,
                model      TEXT    NOT NULL,
                input      INTEGER NOT NULL DEFAULT 0,
                output     INTEGER NOT NULL DEFAULT 0,
                calls      INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (thread_id, date, provider, model)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_token_usage_thread_date ON token_usage(thread_id, date DESC)`,
        ];
        for (const stmt of ddl) {
            this.db.prepare(stmt).run();
        }
        log.info('token_usage table ready (v2)');
    }

    /**
     * v3 migration: conversation messages + FTS5 content index.
     *
     * The messages table is the authoritative transcript; `messages_fts` is a
     * contentless FTS5 virtual table that indexes only `content` and looks up
     * the row via the shared rowid. Triggers keep them in sync so callers
     * only ever touch `messages` directly.
     *
     * Tokenizer: `porter unicode61 remove_diacritics 2` — case-insensitive,
     * diacritics-normalised, porter stemming so "running" / "ran" match "run".
     * Unicode61 handles multi-byte tokens cleanly (CJK, emoji-adjacent text).
     *
     * All FTS5 DDL is guarded: FTS5 is bundled with better-sqlite3's default
     * amalgamation, but if a custom build dropped it we'd rather fail LOUDLY
     * at first startup than surface "no such module: fts5" inside a tool call.
     */
    private applyMessagesSchema(): void {
        const ddl = [
            `CREATE TABLE IF NOT EXISTS messages (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    TEXT    NOT NULL,
                thread_id  TEXT    NOT NULL,
                role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
                content    TEXT    NOT NULL,
                created_at INTEGER NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_messages_user_time
                ON messages(user_id, created_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_messages_thread_time
                ON messages(thread_id, created_at)`,
            // Contentless FTS5 table — stores only the inverted index; the
            // underlying row lives in `messages`. `content_rowid=id` means
            // FTS5 uses `messages.id` as the shared rowid so the JOIN in
            // searchMessages() is a pure rowid lookup.
            `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                content,
                content='messages',
                content_rowid='id',
                tokenize='porter unicode61 remove_diacritics 2'
            )`,
            // Triggers: INSERT and DELETE on messages keep FTS5 current. No
            // UPDATE trigger — we never edit content, only insert/delete.
            `CREATE TRIGGER IF NOT EXISTS messages_ai
                AFTER INSERT ON messages BEGIN
                  INSERT INTO messages_fts(rowid, content)
                    VALUES (new.id, new.content);
                END`,
            `CREATE TRIGGER IF NOT EXISTS messages_ad
                AFTER DELETE ON messages BEGIN
                  INSERT INTO messages_fts(messages_fts, rowid, content)
                    VALUES('delete', old.id, old.content);
                END`,
        ];
        for (const stmt of ddl) {
            try {
                this.db.prepare(stmt).run();
            } catch (err) {
                // FTS5 missing from the SQLite build surfaces here. Re-raise
                // with a hint so the operator knows what to rebuild rather
                // than chasing "no such module" across the stack.
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
        }
        log.info('messages + fts5 table ready (v3)');
    }

    private applyInitialSchema(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategies (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL,
        name             TEXT NOT NULL,
        description      TEXT,
        domain           TEXT,
        effectiveness    REAL NOT NULL,
        uses             INTEGER NOT NULL DEFAULT 0,
        last_used        INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        refinements      INTEGER NOT NULL DEFAULT 0,
        linked_skill_id  TEXT,
        tags             TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_strategies_user ON strategies(user_id, effectiveness DESC);
      CREATE INDEX IF NOT EXISTS idx_strategies_domain ON strategies(user_id, domain);

      CREATE TABLE IF NOT EXISTS lessons (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL,
        rule             TEXT NOT NULL,
        reason           TEXT,
        domain           TEXT,
        severity         TEXT NOT NULL DEFAULT 'important',
        recorded_at      INTEGER NOT NULL,
        prevention_count INTEGER NOT NULL DEFAULT 0,
        applies_to       TEXT NOT NULL DEFAULT 'user:all',
        example_mistake  TEXT,
        correction       TEXT,
        tags             TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_lessons_user ON lessons(user_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_lessons_domain ON lessons(user_id, domain);

      CREATE TABLE IF NOT EXISTS skills_meta (
        user_id        TEXT NOT NULL,
        skill_name     TEXT NOT NULL,
        effectiveness  REAL NOT NULL DEFAULT 0.5,
        success_rate   REAL NOT NULL DEFAULT 0.5,
        use_count      INTEGER NOT NULL DEFAULT 0,
        success_count  INTEGER NOT NULL DEFAULT 0,
        failure_count  INTEGER NOT NULL DEFAULT 0,
        last_used      INTEGER NOT NULL DEFAULT 0,
        last_updated   INTEGER NOT NULL,
        tags           TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (user_id, skill_name)
      );
      CREATE INDEX IF NOT EXISTS idx_skills_eff ON skills_meta(user_id, effectiveness DESC);

      CREATE TABLE IF NOT EXISTS facts (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        subject        TEXT NOT NULL,
        predicate      TEXT NOT NULL,
        object         TEXT NOT NULL,
        validity_start INTEGER NOT NULL,
        validity_end   INTEGER,
        confidence     REAL NOT NULL DEFAULT 1.0,
        source         TEXT NOT NULL DEFAULT 'explicit'
      );
      CREATE INDEX IF NOT EXISTS idx_facts_current ON facts(user_id, subject, predicate, validity_end);

      -- ── Peer + Session model (PR 4) ─────────────────────────────────
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
        source                TEXT NOT NULL DEFAULT 'user'
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_peer
        ON sessions(peer_id, opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_active
        ON sessions(peer_id) WHERE closed_at IS NULL;
    `);
        log.info('initial schema applied');
    }
}

// ── Peer + Session types (PR 4) ────────────────────────────────────────

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
}

export type SessionCloseReason = 'idle' | 'daily' | 'length' | 'user' | 'migration';
export type SessionSource = 'user' | 'heartbeat' | 'cron' | 'webhook';

// Row → Model converters -----------------------------------------------------

function rowToStrategy(r: DbStrategyRow): Strategy {
    const severityTags: Strategy['tags'] = safeJsonParse<string[]>(r.tags, []);
    return {
        id: r.id,
        name: r.name,
        description: r.description ?? '',
        domain: r.domain ?? undefined,
        effectiveness: r.effectiveness,
        uses: r.uses,
        lastUsed: r.last_used,
        createdAt: r.created_at,
        refinements: r.refinements,
        linkedSkillId: r.linked_skill_id ?? undefined,
        tags: severityTags,
    };
}

function rowToLesson(r: DbLessonRow): Lesson {
    return {
        id: r.id,
        rule: r.rule,
        reason: r.reason ?? '',
        domain: r.domain ?? undefined,
        severity: r.severity as Lesson['severity'],
        recordedAt: r.recorded_at,
        preventionCount: r.prevention_count,
        appliesTo: r.applies_to,
        exampleMistake: r.example_mistake ?? undefined,
        correction: r.correction ?? undefined,
        tags: safeJsonParse<string[]>(r.tags, []),
    };
}

function rowToSkillMeta(r: DbSkillMetaRow): SkillEffectivenessEntry {
    return {
        effectiveness: r.effectiveness,
        successRate: r.success_rate,
        useCount: r.use_count,
        successCount: r.success_count,
        failureCount: r.failure_count,
        lastUsed: r.last_used,
        lastUpdated: r.last_updated,
        tags: safeJsonParse<string[]>(r.tags, []),
    };
}

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

function rowToFact(r: DbFactRow): FactRow {
    return {
        id: r.id,
        userId: r.user_id,
        subject: r.subject,
        predicate: r.predicate,
        object: r.object,
        validityStart: r.validity_start,
        validityEnd: r.validity_end,
        confidence: r.confidence,
        source: r.source,
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

function safeJsonParse<T>(raw: unknown, fallback: T): T {
    if (typeof raw !== 'string') return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

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
