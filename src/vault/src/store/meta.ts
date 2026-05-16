import type { Database as Db } from 'better-sqlite3';
import { type Sealed } from '../crypto/cipher';

const VERIFIER_PLAINTEXT = Buffer.from('flopsy-vault-v1', 'utf8');

export function getMeta(db: Db, key: string): Buffer | undefined {
    const row = db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as
        | { value: Buffer }
        | undefined;
    return row?.value;
}

export function putMeta(db: Db, key: string, value: Buffer): void {
    db.prepare(
        'INSERT INTO vault_meta(key, value) VALUES (?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
}

export function encodeSealed(s: Sealed): Buffer {
    return Buffer.concat([s.nonce, s.tag, s.ciphertext]);
}

export function decodeSealed(buf: Buffer): Sealed {
    if (buf.length < 12 + 16) throw new Error('sealed buffer too short');
    return {
        nonce: buf.subarray(0, 12),
        tag: buf.subarray(12, 28),
        ciphertext: buf.subarray(28),
    };
}

export function getVerifierPlaintext(): Buffer {
    return VERIFIER_PLAINTEXT;
}

export function isVaultInitialised(db: Db): boolean {
    return getMeta(db, 'salt') !== undefined && getMeta(db, 'wrapped_dek') !== undefined;
}
