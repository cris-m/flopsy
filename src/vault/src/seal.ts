import type { Database as Db } from 'better-sqlite3';
import { newKey, open, seal } from './crypto/cipher';
import { deriveKek, newSalt, wipe } from './crypto/kdf';
import { decodeSealed, encodeSealed, getMeta, getVerifierPlaintext, isVaultInitialised, putMeta } from './store/meta';

export class VaultSealError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VaultSealError';
    }
}

export function initVault(db: Db, masterPassword: string): void {
    if (isVaultInitialised(db)) {
        throw new VaultSealError('vault already initialised — use change-password to rotate');
    }
    const salt = newSalt();
    const kek = deriveKek(masterPassword, salt);
    try {
        const dek = newKey();
        try {
            const wrapped = seal(kek, dek, Buffer.from('flopsy-vault-dek', 'utf8'));
            const verifier = seal(dek, getVerifierPlaintext(), Buffer.from('flopsy-vault-verifier', 'utf8'));
            db.transaction(() => {
                putMeta(db, 'salt', salt);
                putMeta(db, 'wrapped_dek', encodeSealed(wrapped));
                putMeta(db, 'verifier', encodeSealed(verifier));
            })();
        } finally {
            wipe(dek);
        }
    } finally {
        wipe(kek);
    }
}

export function unsealVault(db: Db, masterPassword: string): Buffer {
    if (!isVaultInitialised(db)) {
        throw new VaultSealError('vault not initialised — run `flopsy vault init` first');
    }
    const salt = getMeta(db, 'salt');
    const wrappedRaw = getMeta(db, 'wrapped_dek');
    const verifierRaw = getMeta(db, 'verifier');
    if (!salt || !wrappedRaw || !verifierRaw) {
        throw new VaultSealError('vault metadata is incomplete');
    }
    const kek = deriveKek(masterPassword, salt);
    try {
        let dek: Buffer;
        try {
            dek = open(kek, decodeSealed(wrappedRaw), Buffer.from('flopsy-vault-dek', 'utf8'));
        } catch {
            throw new VaultSealError('wrong master password');
        }
        try {
            const verified = open(dek, decodeSealed(verifierRaw), Buffer.from('flopsy-vault-verifier', 'utf8'));
            if (!verified.equals(getVerifierPlaintext())) {
                throw new VaultSealError('verifier mismatch — vault corrupt');
            }
        } catch (err) {
            wipe(dek);
            if (err instanceof VaultSealError) throw err;
            throw new VaultSealError('verifier decrypt failed — vault corrupt');
        }
        return dek;
    } finally {
        wipe(kek);
    }
}

export function changeMasterPassword(
    db: Db,
    currentPassword: string,
    newPassword: string,
): void {
    const dek = unsealVault(db, currentPassword);
    try {
        const salt = newSalt();
        const kek = deriveKek(newPassword, salt);
        try {
            const wrapped = seal(kek, dek, Buffer.from('flopsy-vault-dek', 'utf8'));
            db.transaction(() => {
                putMeta(db, 'salt', salt);
                putMeta(db, 'wrapped_dek', encodeSealed(wrapped));
            })();
        } finally {
            wipe(kek);
        }
    } finally {
        wipe(dek);
    }
}
