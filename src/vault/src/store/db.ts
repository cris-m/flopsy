import Database, { type Database as Db } from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export interface OpenDbOptions {
    path: string;
    readOnly?: boolean;
}

function runSchema(db: Db, sql: string): void {
    const cleaned = sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
    const statements = cleaned
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    db.transaction(() => {
        for (const stmt of statements) {
            db.prepare(stmt).run();
        }
    })();
}

export function openVaultDb(opts: OpenDbOptions): Db {
    const dir = dirname(opts.path);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const db = new Database(opts.path, { readonly: opts.readOnly === true });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = FULL');
    db.pragma('wal_autocheckpoint = 1000');
    db.pragma('journal_size_limit = 67108864');

    if (!opts.readOnly) {
        const ddl = readFileSync(SCHEMA_PATH, 'utf8');
        runSchema(db, ddl);
        try {
            chmodSync(opts.path, 0o600);
        } catch {
            /* */
        }
    }
    return db;
}

export function closeVaultDb(db: Db): void {
    if (db.open) db.close();
}
