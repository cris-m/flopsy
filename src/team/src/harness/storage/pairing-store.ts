import type DatabaseModule from 'better-sqlite3';
type Database = DatabaseModule.Database;
import { randomBytes } from 'node:crypto';
import { createLogger } from '@flopsy/shared';
import { closeSharedLearningStore, getSharedLearningStore } from './learning-store';

const log = createLogger('pairing-store');

// No 0/O/1/I — operators read these codes back over voice/chat.
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;
export const PAIRING_MAX_PENDING_PER_CHANNEL = 3;

export interface PairingPending {
    readonly channel: string;
    readonly code: string;
    readonly senderId: string;
    readonly senderName: string | null;
    readonly createdAt: number;
}

export interface PairingApproved {
    readonly channel: string;
    readonly senderId: string;
    readonly senderName: string | null;
    readonly approvedAt: number;
}

export interface RequestCodeResult {
    readonly code: string;
    readonly isNew: boolean;
}

const SCHEMA_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS pairing_pending (
        channel       TEXT NOT NULL,
        code          TEXT NOT NULL,
        sender_id     TEXT NOT NULL,
        sender_name   TEXT,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (channel, sender_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pairing_pending_code
        ON pairing_pending(channel, code)`,
    `CREATE INDEX IF NOT EXISTS idx_pairing_pending_created
        ON pairing_pending(created_at)`,
    `CREATE TABLE IF NOT EXISTS pairing_approved (
        channel       TEXT NOT NULL,
        sender_id     TEXT NOT NULL,
        sender_name   TEXT,
        approved_at   INTEGER NOT NULL,
        PRIMARY KEY (channel, sender_id)
    )`,
];

let sharedInstance: PairingStore | null = null;

// Shares LearningStore's connection so writers serialize through one WAL writer.
export function getSharedPairingStore(): PairingStore {
    if (!sharedInstance) {
        const db = getSharedLearningStore().getDatabase();
        sharedInstance = new PairingStore(db);
    }
    return sharedInstance;
}

export function closeSharedPairingStore(): void {
    sharedInstance = null;
    closeSharedLearningStore();
}

export class PairingStore {
    constructor(private readonly db: Database) {
        this.applySchema();
    }

    private applySchema(): void {
        for (const ddl of SCHEMA_STATEMENTS) {
            this.db.prepare(ddl).run();
        }
    }

    requestCode(
        channel: string,
        senderId: string,
        senderName?: string,
    ): RequestCodeResult | null {
        const now = Date.now();
        const existing = this.db
            .prepare(
                'SELECT code, created_at FROM pairing_pending WHERE channel = ? AND sender_id = ?',
            )
            .get(channel, senderId) as { code: string; created_at: number } | undefined;

        if (existing && now - existing.created_at < PAIRING_PENDING_TTL_MS) {
            return { code: existing.code, isNew: false };
        }

        // Sweep before counting toward cap so expired rows don't lock out new senders.
        this.clearExpired(channel);

        const pending = this.db
            .prepare('SELECT COUNT(*) as cnt FROM pairing_pending WHERE channel = ?')
            .get(channel) as { cnt: number };

        if (pending.cnt >= PAIRING_MAX_PENDING_PER_CHANNEL) {
            log.warn(
                { channel, pending: pending.cnt },
                'pairing pending cap reached — refusing new code',
            );
            return null;
        }

        const code = generateCode();
        this.db
            .prepare(
                `INSERT OR REPLACE INTO pairing_pending
                  (channel, code, sender_id, sender_name, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(channel, code, senderId, senderName ?? null, now);

        log.info({ channel, senderId, code }, 'pairing code issued');
        return { code, isNew: true };
    }

    approveByCode(
        channel: string,
        code: string,
    ): { senderId: string; senderName: string | null } | null {
        const normalized = code.toUpperCase().trim();
        const row = this.db
            .prepare(
                `SELECT sender_id, sender_name, created_at
                 FROM pairing_pending
                 WHERE channel = ? AND code = ?`,
            )
            .get(channel, normalized) as
            | { sender_id: string; sender_name: string | null; created_at: number }
            | undefined;

        if (!row) {
            log.info({ channel, code: normalized }, 'pairing approve: code not found');
            return null;
        }
        if (Date.now() - row.created_at >= PAIRING_PENDING_TTL_MS) {
            log.info({ channel, code: normalized }, 'pairing approve: code expired');
            this.db
                .prepare('DELETE FROM pairing_pending WHERE channel = ? AND code = ?')
                .run(channel, normalized);
            return null;
        }

        this.approveBySenderId(channel, row.sender_id, row.sender_name ?? undefined);
        return { senderId: row.sender_id, senderName: row.sender_name };
    }

    approveBySenderId(
        channel: string,
        senderId: string,
        senderName?: string,
    ): void {
        const now = Date.now();
        this.db
            .prepare(
                `INSERT OR REPLACE INTO pairing_approved
                  (channel, sender_id, sender_name, approved_at)
                 VALUES (?, ?, ?, ?)`,
            )
            .run(channel, senderId, senderName ?? null, now);
        this.db
            .prepare('DELETE FROM pairing_pending WHERE channel = ? AND sender_id = ?')
            .run(channel, senderId);
        log.info({ channel, senderId }, 'pairing approved');
    }

    revoke(channel: string, senderId: string): boolean {
        const r = this.db
            .prepare('DELETE FROM pairing_approved WHERE channel = ? AND sender_id = ?')
            .run(channel, senderId);
        const removed = r.changes > 0;
        if (removed) log.info({ channel, senderId }, 'pairing revoked');
        return removed;
    }

    isApproved(channel: string, senderId: string): boolean {
        const r = this.db
            .prepare(
                'SELECT 1 FROM pairing_approved WHERE channel = ? AND sender_id = ? LIMIT 1',
            )
            .get(channel, senderId);
        return r !== undefined;
    }

    listPending(channel?: string): readonly PairingPending[] {
        const rows = (channel
            ? this.db
                  .prepare(
                      'SELECT * FROM pairing_pending WHERE channel = ? ORDER BY created_at DESC',
                  )
                  .all(channel)
            : this.db
                  .prepare('SELECT * FROM pairing_pending ORDER BY created_at DESC')
                  .all()) as Array<{
            channel: string;
            code: string;
            sender_id: string;
            sender_name: string | null;
            created_at: number;
        }>;
        return rows.map(rowToPending);
    }

    listApproved(channel?: string): readonly PairingApproved[] {
        const rows = (channel
            ? this.db
                  .prepare(
                      'SELECT * FROM pairing_approved WHERE channel = ? ORDER BY approved_at DESC',
                  )
                  .all(channel)
            : this.db
                  .prepare('SELECT * FROM pairing_approved ORDER BY approved_at DESC')
                  .all()) as Array<{
            channel: string;
            sender_id: string;
            sender_name: string | null;
            approved_at: number;
        }>;
        return rows.map(rowToApproved);
    }

    clearExpired(channel?: string): number {
        const cutoff = Date.now() - PAIRING_PENDING_TTL_MS;
        const r = channel
            ? this.db
                  .prepare(
                      'DELETE FROM pairing_pending WHERE channel = ? AND created_at < ?',
                  )
                  .run(channel, cutoff)
            : this.db
                  .prepare('DELETE FROM pairing_pending WHERE created_at < ?')
                  .run(cutoff);
        return r.changes;
    }

    clearAllPending(channel?: string): number {
        const r = channel
            ? this.db
                  .prepare('DELETE FROM pairing_pending WHERE channel = ?')
                  .run(channel)
            : this.db.prepare('DELETE FROM pairing_pending').run();
        return r.changes;
    }
}

function generateCode(): string {
    const buf = randomBytes(PAIRING_CODE_LENGTH);
    let out = '';
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
        out += PAIRING_CODE_ALPHABET[buf[i]! % PAIRING_CODE_ALPHABET.length];
    }
    return out;
}

function rowToPending(r: {
    channel: string;
    code: string;
    sender_id: string;
    sender_name: string | null;
    created_at: number;
}): PairingPending {
    return {
        channel: r.channel,
        code: r.code,
        senderId: r.sender_id,
        senderName: r.sender_name,
        createdAt: r.created_at,
    };
}

function rowToApproved(r: {
    channel: string;
    sender_id: string;
    sender_name: string | null;
    approved_at: number;
}): PairingApproved {
    return {
        channel: r.channel,
        senderId: r.sender_id,
        senderName: r.sender_name,
        approvedAt: r.approved_at,
    };
}
