import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;

export interface Sealed {
    nonce: Buffer;
    tag: Buffer;
    ciphertext: Buffer;
}

export function seal(key: Buffer, plaintext: Buffer, aad?: Buffer): Sealed {
    if (key.length !== KEY_BYTES) {
        throw new Error(`key must be ${KEY_BYTES} bytes`);
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    if (aad) cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { nonce, tag, ciphertext };
}

export function open(key: Buffer, sealed: Sealed, aad?: Buffer): Buffer {
    if (key.length !== KEY_BYTES) {
        throw new Error(`key must be ${KEY_BYTES} bytes`);
    }
    if (sealed.nonce.length !== NONCE_BYTES) {
        throw new Error(`nonce must be ${NONCE_BYTES} bytes`);
    }
    if (sealed.tag.length !== TAG_BYTES) {
        throw new Error(`tag must be ${TAG_BYTES} bytes`);
    }
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: TAG_BYTES });
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

export function newKey(): Buffer {
    return randomBytes(KEY_BYTES);
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
