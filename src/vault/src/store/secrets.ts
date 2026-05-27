import type { Database as Db } from 'better-sqlite3';
import { open, seal } from '../crypto/cipher';

export interface SecretRow {
    name: string;
    createdAt: number;
    updatedAt: number;
}

export function putSecret(db: Db, dek: Buffer, name: string, plaintext: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name)) {
        throw new Error(
            'secret name must start with a letter or _ and contain only [A-Za-z0-9_.-]',
        );
    }
    const aad = Buffer.from(name, 'utf8');
    const pt = Buffer.from(plaintext, 'utf8');
    const sealed = seal(dek, pt, aad);
    pt.fill(0);
    const now = Date.now();
    db.prepare(
        `INSERT INTO vault_secrets(name, nonce, tag, ciphertext, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
             nonce = excluded.nonce,
             tag = excluded.tag,
             ciphertext = excluded.ciphertext,
             updated_at = excluded.updated_at`,
    ).run(name, sealed.nonce, sealed.tag, sealed.ciphertext, now, now);
}

export function getSecret(db: Db, dek: Buffer, name: string): string | undefined {
    const row = db
        .prepare('SELECT nonce, tag, ciphertext FROM vault_secrets WHERE name = ?')
        .get(name) as { nonce: Buffer; tag: Buffer; ciphertext: Buffer } | undefined;
    if (!row) return undefined;
    const aad = Buffer.from(name, 'utf8');
    const pt = open(dek, row, aad);
    const out = pt.toString('utf8');
    pt.fill(0);
    return out;
}

const LIST_SECRETS_DEFAULT_LIMIT = 500;
const LIST_SECRETS_MAX_LIMIT = 5000;

export function listSecrets(db: Db, opts: { limit?: number; offset?: number } = {}): SecretRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? LIST_SECRETS_DEFAULT_LIMIT, LIST_SECRETS_MAX_LIMIT));
    const offset = Math.max(0, opts.offset ?? 0);
    const rows = db
        .prepare(
            'SELECT name, created_at as createdAt, updated_at as updatedAt FROM vault_secrets ORDER BY name LIMIT ? OFFSET ?',
        )
        .all(limit, offset) as SecretRow[];
    return rows;
}

export function deleteSecret(db: Db, name: string): boolean {
    const info = db.prepare('DELETE FROM vault_secrets WHERE name = ?').run(name);
    return info.changes > 0;
}
