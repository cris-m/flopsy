import type { Database as Db } from 'better-sqlite3';
import { createHmac } from 'node:crypto';

export interface AuditEntry {
    actorToken: string;
    action: string;
    resource?: string;
    outcome: 'success' | string;
    metadata?: Record<string, unknown>;
}

const CHAIN_KEY_AAD = 'flopsy-vault-audit-chain';

function chainKey(dek: Buffer): Buffer {
    return createHmac('sha256', dek).update(CHAIN_KEY_AAD).digest();
}

function lastChainHmac(db: Db): Buffer {
    const row = db
        .prepare('SELECT chain_hmac FROM vault_audit ORDER BY id DESC LIMIT 1')
        .get() as { chain_hmac: Buffer } | undefined;
    return row?.chain_hmac ?? Buffer.alloc(32);
}

export interface AuditRow {
    id: number;
    tsMs: number;
    actorToken: string;
    action: string;
    resource: string | null;
    outcome: string;
    metadata: string | null;
}

export interface ListAuditOptions {
    sinceMs?: number;
    limit?: number;
    actorToken?: string;
    action?: string;
}

export function listAudit(db: Db, opts: ListAuditOptions = {}): AuditRow[] {
    const clauses: string[] = [];
    const params: (number | string)[] = [];
    if (opts.sinceMs !== undefined) {
        clauses.push('ts_ms >= ?');
        params.push(opts.sinceMs);
    }
    if (opts.actorToken) {
        clauses.push('actor_token = ?');
        params.push(opts.actorToken);
    }
    if (opts.action) {
        clauses.push('action = ?');
        params.push(opts.action);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    const sql = `SELECT id, ts_ms as tsMs, actor_token as actorToken, action, resource, outcome, metadata
                 FROM vault_audit ${where}
                 ORDER BY id DESC
                 LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params) as AuditRow[];
}

export function appendAudit(db: Db, dek: Buffer, entry: AuditEntry): void {
    const key = chainKey(dek);
    const prev = lastChainHmac(db);
    const ts = Date.now();
    const meta = entry.metadata ? JSON.stringify(entry.metadata) : null;
    const fields = Buffer.from(
        [ts, entry.actorToken, entry.action, entry.resource ?? '', entry.outcome, meta ?? ''].join(''),
        'utf8',
    );
    const mac = createHmac('sha256', key).update(prev).update(fields).digest();
    key.fill(0);
    db.prepare(
        `INSERT INTO vault_audit(ts_ms, actor_token, action, resource, outcome, metadata, chain_hmac)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(ts, entry.actorToken, entry.action, entry.resource ?? null, entry.outcome, meta, mac);
}
