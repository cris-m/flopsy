import { argon2id } from '@noble/hashes/argon2';
import { randomBytes } from 'node:crypto';

export const KDF_PARAMS = {
    t: 3,
    m: 65536,
    p: 4,
    dkLen: 32,
} as const;

export const SALT_BYTES = 16;

export function newSalt(): Buffer {
    return randomBytes(SALT_BYTES);
}

export function deriveKek(password: string, salt: Buffer): Buffer {
    if (password.length === 0) {
        throw new Error('master password must not be empty');
    }
    if (salt.length !== SALT_BYTES) {
        throw new Error(`salt must be ${SALT_BYTES} bytes, got ${salt.length}`);
    }
    const out = argon2id(password, salt, KDF_PARAMS);
    return Buffer.from(out);
}

export function wipe(buf: Buffer): void {
    buf.fill(0);
}
