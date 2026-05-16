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
