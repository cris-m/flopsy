import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import { createLogger } from '@flopsy/shared';

const log = createLogger('proactive-dedup');

/** Max reported-item rows per (type, source); cap protects disk + lookup time. */
const MAX_REPORTED_PER_SOURCE = 5000;

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS proactive_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        delivered_at INTEGER NOT NULL,
        suppressed INTEGER NOT NULL DEFAULT 0,
        mode TEXT,
        overlay TEXT,
        reason TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_proactive_deliveries_delivered_at
        ON proactive_deliveries(delivered_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_proactive_deliveries_source
        ON proactive_deliveries(source)`,
    // idx_proactive_deliveries_mode created post-migration; requires `mode` column.
    `CREATE TABLE IF NOT EXISTS proactive_reported (
        type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (type, item_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_proactive_reported_at
        ON proactive_reported(reported_at DESC)`,
    `CREATE TABLE IF NOT EXISTS proactive_runtime_schedules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        created_by_thread TEXT,
        created_by_agent TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_schedules_kind
        ON proactive_runtime_schedules(kind)`,
];

export interface RuntimeScheduleRow {
    id: string;
    kind: 'heartbeat' | 'cron' | 'webhook';
    configJson: string;
    enabled: boolean;
    createdAt: number;
    createdByThread: string | null;
    createdByAgent: string | null;
}

export interface SimilarMatch {
    source: string;
    deliveredAt: number;
    similarity: number;
    contentPreview: string;
}

/** SQLite store for delivery history + reported-item tracking at <FLOPSY_HOME>/state/proactive.db. */
export class ProactiveDedupStore {
    private readonly db: Database.Database;
    private readonly stmtInsertDelivery: Database.Statement;
    private readonly stmtSelectRecent: Database.Statement;
    private readonly stmtPruneDeliveries: Database.Statement;
    private readonly stmtInsertReported: Database.Statement;
    private readonly stmtCheckReported: Database.Statement;
    private readonly stmtListReported: Database.Statement;
    private readonly stmtPruneReported: Database.Statement;
    private readonly stmtCapReportedPerSource: Database.Statement;
    private readonly stmtInsertSchedule: Database.Statement;
    private readonly stmtListSchedules: Database.Statement;
    private readonly stmtGetSchedule: Database.Statement;
    private readonly stmtUpdateSchedule: Database.Statement;
    private readonly stmtUpdateScheduleConfig: Database.Statement;
    private readonly stmtDeleteSchedule: Database.Statement;
    private closed = false;

    constructor(dbPath: string) {
        mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
        this.db = new Database(dbPath);
        // Force 0600 — better-sqlite3's umask default is world-readable.
        try {
            chmodSync(dbPath, 0o600);
        } catch {
            // Permission denied → rely on the dir's 0700 perms.
        }
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('busy_timeout = 5000');
        // Cap WAL at 64 MB; paired with default wal_autocheckpoint = 1000.
        this.db.pragma('journal_size_limit = 67108864');
        this.db.pragma('wal_autocheckpoint = 1000');
        for (const stmt of SCHEMA_STATEMENTS) {
            this.db.prepare(stmt).run();
        }

        // Column migrations: ALTER ADD COLUMN is no-op on existing column (errors caught).
        const ensureColumn = (name: string, ddl: string): void => {
            try {
                this.db.prepare(`ALTER TABLE proactive_deliveries ADD COLUMN ${ddl}`).run();
                log.info({ column: name }, 'migrated proactive_deliveries: added column');
            } catch (err) {
                // "duplicate column name" is expected on already-migrated DBs.
                const msg = err instanceof Error ? err.message : String(err);
                if (!/duplicate column name/i.test(msg)) {
                    log.warn({ column: name, err: msg }, 'column migration failed');
                }
            }
        };
        ensureColumn('suppressed', 'suppressed INTEGER NOT NULL DEFAULT 0');
        ensureColumn('mode', 'mode TEXT');
        ensureColumn('overlay', 'overlay TEXT');
        ensureColumn('reason', 'reason TEXT');

        // Index over (source, mode, delivered_at) — needs `mode` column.
        try {
            this.db
                .prepare(
                    `CREATE INDEX IF NOT EXISTS idx_proactive_deliveries_mode
                     ON proactive_deliveries(source, mode, delivered_at DESC)`,
                )
                .run();
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'idx_proactive_deliveries_mode creation failed (non-fatal)',
            );
        }

        this.stmtInsertDelivery = this.db.prepare(
            `INSERT INTO proactive_deliveries
                (source, content, embedding, delivered_at, suppressed, mode, overlay, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        // Similarity dedup checks DELIVERED only; LIMIT 500 caps the in-memory cosine scan.
        this.stmtSelectRecent = this.db.prepare(
            `SELECT source, content, embedding, delivered_at
             FROM proactive_deliveries
             WHERE delivered_at >= ?
               AND embedding IS NOT NULL
               AND suppressed = 0
             ORDER BY delivered_at DESC
             LIMIT 500`,
        );
        this.stmtPruneDeliveries = this.db.prepare(
            `DELETE FROM proactive_deliveries WHERE delivered_at < ?`,
        );
        this.stmtInsertReported = this.db.prepare(
            `INSERT OR REPLACE INTO proactive_reported (type, item_id, reported_at, source)
             VALUES (?, ?, ?, ?)`,
        );
        this.stmtCheckReported = this.db.prepare(
            `SELECT 1 FROM proactive_reported WHERE type = ? AND item_id = ? LIMIT 1`,
        );
        this.stmtListReported = this.db.prepare(
            `SELECT item_id FROM proactive_reported
             WHERE type = ? ORDER BY reported_at DESC LIMIT ?`,
        );
        this.stmtPruneReported = this.db.prepare(
            `DELETE FROM proactive_reported WHERE reported_at < ?`,
        );
        // Per-source cap during prune: window-fn keeps N most-recent per (type, source).
        this.stmtCapReportedPerSource = this.db.prepare(
            `DELETE FROM proactive_reported
             WHERE rowid IN (
                 SELECT rowid FROM (
                     SELECT rowid,
                            ROW_NUMBER() OVER (
                                PARTITION BY type, source
                                ORDER BY reported_at DESC
                            ) AS rn
                     FROM proactive_reported
                 )
                 WHERE rn > ?
             )`,
        );

        this.stmtInsertSchedule = this.db.prepare(
            `INSERT OR IGNORE INTO proactive_runtime_schedules
                (id, kind, config_json, enabled, created_at, created_by_thread, created_by_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        this.stmtListSchedules = this.db.prepare(
            `SELECT id, kind, config_json, enabled, created_at,
                    created_by_thread, created_by_agent
             FROM proactive_runtime_schedules
             ORDER BY created_at DESC`,
        );
        this.stmtGetSchedule = this.db.prepare(
            `SELECT id, kind, config_json, enabled, created_at,
                    created_by_thread, created_by_agent
             FROM proactive_runtime_schedules WHERE id = ?`,
        );
        this.stmtUpdateSchedule = this.db.prepare(
            `UPDATE proactive_runtime_schedules
             SET enabled = ?, config_json = ? WHERE id = ?`,
        );
        this.stmtUpdateScheduleConfig = this.db.prepare(
            `UPDATE proactive_runtime_schedules
             SET config_json = ? WHERE id = ?`,
        );
        this.stmtDeleteSchedule = this.db.prepare(
            `DELETE FROM proactive_runtime_schedules WHERE id = ?`,
        );

        log.info({ path: dbPath }, 'proactive dedup store ready');
    }

    insertRuntimeSchedule(row: {
        id: string;
        kind: 'heartbeat' | 'cron' | 'webhook';
        config: unknown;
        enabled?: boolean;
        createdByThread?: string;
        createdByAgent?: string;
    }): void {
        this.stmtInsertSchedule.run(
            row.id,
            row.kind,
            JSON.stringify(row.config),
            row.enabled === false ? 0 : 1,
            Date.now(),
            row.createdByThread ?? null,
            row.createdByAgent ?? null,
        );
    }

    listRuntimeSchedules(): RuntimeScheduleRow[] {
        return (this.stmtListSchedules.all() as Array<{
            id: string;
            kind: string;
            config_json: string;
            enabled: number;
            created_at: number;
            created_by_thread: string | null;
            created_by_agent: string | null;
        }>).map((r) => ({
            id: r.id,
            kind: r.kind as 'heartbeat' | 'cron',
            configJson: r.config_json,
            enabled: r.enabled === 1,
            createdAt: r.created_at,
            createdByThread: r.created_by_thread,
            createdByAgent: r.created_by_agent,
        }));
    }

    getRuntimeSchedule(id: string): RuntimeScheduleRow | null {
        const r = this.stmtGetSchedule.get(id) as
            | {
                  id: string;
                  kind: string;
                  config_json: string;
                  enabled: number;
                  created_at: number;
                  created_by_thread: string | null;
                  created_by_agent: string | null;
              }
            | undefined;
        if (!r) return null;
        return {
            id: r.id,
            kind: r.kind as 'heartbeat' | 'cron',
            configJson: r.config_json,
            enabled: r.enabled === 1,
            createdAt: r.created_at,
            createdByThread: r.created_by_thread,
            createdByAgent: r.created_by_agent,
        };
    }

    setRuntimeScheduleEnabled(id: string, enabled: boolean): boolean {
        const existing = this.getRuntimeSchedule(id);
        if (!existing) return false;
        this.stmtUpdateSchedule.run(enabled ? 1 : 0, existing.configJson, id);
        return true;
    }

    /** Preserves enabled / created_at / created_by_*. */
    updateRuntimeScheduleConfig(id: string, config: unknown): boolean {
        const existing = this.getRuntimeSchedule(id);
        if (!existing) return false;
        this.stmtUpdateScheduleConfig.run(JSON.stringify(config), id);
        return true;
    }

    deleteRuntimeSchedule(id: string): boolean {
        return this.stmtDeleteSchedule.run(id).changes > 0;
    }

    /** Record a delivered/suppressed turn; suppressed entries feed the anti-rep block. */
    recordDelivery(
        source: string,
        content: string,
        embedding?: number[],
        meta: {
            suppressed?: boolean;
            mode?: string | null;
            overlay?: string | null;
            reason?: string | null;
        } = {},
    ): void {
        const blob = embedding ? floatsToBuffer(embedding) : null;
        this.stmtInsertDelivery.run(
            source,
            content.slice(0, 4000),
            blob,
            Date.now(),
            meta.suppressed ? 1 : 0,
            meta.mode ?? null,
            meta.overlay ?? null,
            meta.reason ? meta.reason.slice(0, 500) : null,
        );
    }

    /** Suppress-path: writes to proactive_deliveries with suppressed=1, no embedding. */
    recordSuppression(
        source: string,
        content: string,
        meta: { mode?: string | null; overlay?: string | null; reason?: string | null } = {},
    ): void {
        this.recordDelivery(source, content, undefined, { ...meta, suppressed: true });
    }

    /** Newest-first. Includes both delivered + suppressed by default. */
    listDeliveriesBySource(
        source: string,
        limit = 20,
        opts: { includeSuppressed?: boolean } = {},
    ): Array<{
        deliveredAt: number;
        content: string;
        suppressed: boolean;
        mode: string | null;
        reason: string | null;
    }> {
        const where = opts.includeSuppressed === false
            ? `source = ? AND suppressed = 0`
            : `source = ?`;
        const stmt = this.db.prepare(
            `SELECT delivered_at, content, suppressed, mode, reason
             FROM proactive_deliveries
             WHERE ${where} ORDER BY delivered_at DESC LIMIT ?`,
        );
        const rows = stmt.all(source, Math.max(1, Math.min(500, limit))) as Array<{
            delivered_at: number;
            content: string;
            suppressed: number;
            mode: string | null;
            reason: string | null;
        }>;
        return rows.map((r) => ({
            deliveredAt: r.delivered_at,
            content: r.content,
            suppressed: r.suppressed === 1,
            mode: r.mode,
            reason: r.reason,
        }));
    }

    /** Last delivered timestamp per mode for one source (smart-pulse cooldown). */
    getLastFiredByMode(source: string): Record<string, number> {
        const stmt = this.db.prepare(
            `SELECT mode, MAX(delivered_at) AS last_at
             FROM proactive_deliveries
             WHERE source = ? AND suppressed = 0 AND mode IS NOT NULL
             GROUP BY mode`,
        );
        const rows = stmt.all(source) as Array<{ mode: string; last_at: number }>;
        const out: Record<string, number> = {};
        for (const r of rows) out[r.mode] = r.last_at;
        return out;
    }

    /** Delivery counts by source for operator-facing audit (not for prompts). */
    countDeliveriesSince(
        sinceMs: number,
        opts: { excludeSources?: ReadonlySet<string> } = {},
    ): { total: number; bySource: Record<string, number> } {
        const stmt = this.db.prepare(
            `SELECT source, COUNT(*) as n FROM proactive_deliveries
             WHERE delivered_at >= ? AND suppressed = 0 GROUP BY source`,
        );
        const rows = stmt.all(sinceMs) as Array<{ source: string; n: number }>;
        const exclude = opts.excludeSources;
        const bySource: Record<string, number> = {};
        let total = 0;
        for (const r of rows) {
            bySource[r.source] = r.n;
            if (!exclude?.has(r.source)) total += r.n;
        }
        return { total, bySource };
    }

    findSimilar(
        embedding: number[],
        threshold: number,
        windowMs: number,
    ): SimilarMatch | null {
        const cutoff = Date.now() - windowMs;
        const rows = this.stmtSelectRecent.all(cutoff) as Array<{
            source: string;
            content: string;
            embedding: Buffer;
            delivered_at: number;
        }>;
        let best: SimilarMatch | null = null;
        const queryNorm = norm(embedding);
        if (queryNorm === 0) return null;

        for (const row of rows) {
            const vec = bufferToFloats(row.embedding);
            if (vec.length !== embedding.length) continue;
            const sim = cosineNormalised(embedding, vec, queryNorm);
            if (sim >= threshold && (!best || sim > best.similarity)) {
                best = {
                    source: row.source,
                    deliveredAt: row.delivered_at,
                    similarity: sim,
                    contentPreview: row.content.slice(0, 160),
                };
            }
        }
        return best;
    }

    markReported(type: string, ids: string[], source: string): number {
        if (ids.length === 0) return 0;
        const now = Date.now();
        const txn = this.db.transaction(() => {
            let n = 0;
            for (const id of ids) {
                this.stmtInsertReported.run(type, id, now, source);
                n++;
            }
            return n;
        });
        return txn();
    }

    isReported(type: string, id: string): boolean {
        return !!this.stmtCheckReported.get(type, id);
    }

    listReported(type: string, limit = 20): string[] {
        return (this.stmtListReported.all(type, limit) as Array<{ item_id: string }>).map(
            (r) => r.item_id,
        );
    }

    prune(
        deliveryMaxAgeMs: number,
        reportedMaxAgeMs: number,
    ): { deliveries: number; reported: number } {
        const deliveries = this.stmtPruneDeliveries.run(Date.now() - deliveryMaxAgeMs).changes;
        const reportedByAge = this.stmtPruneReported.run(Date.now() - reportedMaxAgeMs).changes;
        // Per-source cap runs after time-based prune (cheaper, index-backed).
        const reportedByCap = this.stmtCapReportedPerSource.run(MAX_REPORTED_PER_SOURCE).changes;
        const reported = reportedByAge + reportedByCap;
        // Force TRUNCATE checkpoint so WAL shrinks alongside the row delete.
        if (deliveries > 0 || reported > 0) {
            try {
                this.db.pragma('wal_checkpoint(TRUNCATE)');
            } catch {
                /* best-effort — autocheckpoint will eventually catch up */
            }
        }
        if (deliveries > 0 || reported > 0) {
            log.debug({ deliveries, reported }, 'pruned old proactive records');
        }
        return { deliveries, reported };
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try {
            // TRUNCATE removes .wal from disk (PASSIVE only flushes pages).
            this.db.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
            /* best-effort */
        }
        this.db.close();
    }
}

function floatsToBuffer(vec: number[]): Buffer {
    const arr = new Float32Array(vec);
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToFloats(buf: Buffer): number[] {
    // Float32Array on an unaligned ArrayBuffer throws RangeError; better-sqlite3
    // BLOB buffers aren't guaranteed aligned, so copy into a fresh buffer first.
    const copy = Buffer.from(buf);
    const f32 = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
    return Array.from(f32);
}

function norm(v: readonly number[]): number {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
    return Math.sqrt(s);
}

function cosineNormalised(a: readonly number[], b: readonly number[], aNorm: number): number {
    const bNorm = norm(b);
    if (bNorm === 0) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
    return dot / (aNorm * bNorm);
}
