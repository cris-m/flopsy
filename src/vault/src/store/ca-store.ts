import type { Database as Db } from 'better-sqlite3';
import { open, seal } from '../crypto/cipher';
import { generateRootCA, type CertPair } from '../crypto/ca';
import { decodeSealed, encodeSealed, getMeta, putMeta } from './meta';

const AAD = Buffer.from('flopsy-vault-ca', 'utf8');

export interface RootCA {
    certPem: string;
    keyPem: string;
}

export function loadOrCreateRootCA(db: Db, dek: Buffer): RootCA {
    const certBlob = getMeta(db, 'root_ca_cert');
    const keyBlob = getMeta(db, 'root_ca_key');
    if (certBlob && keyBlob) {
        const certPem = open(dek, decodeSealed(certBlob), AAD).toString('utf8');
        const keyPem = open(dek, decodeSealed(keyBlob), AAD).toString('utf8');
        return { certPem, keyPem };
    }
    const fresh = generateRootCA();
    saveRootCA(db, dek, fresh);
    return fresh;
}

export function saveRootCA(db: Db, dek: Buffer, ca: CertPair): void {
    const sealedCert = seal(dek, Buffer.from(ca.certPem, 'utf8'), AAD);
    const sealedKey = seal(dek, Buffer.from(ca.keyPem, 'utf8'), AAD);
    db.transaction(() => {
        putMeta(db, 'root_ca_cert', encodeSealed(sealedCert));
        putMeta(db, 'root_ca_key', encodeSealed(sealedKey));
    })();
}

export function getRootCertPem(db: Db, dek: Buffer): string | undefined {
    const blob = getMeta(db, 'root_ca_cert');
    if (!blob) return undefined;
    return open(dek, decodeSealed(blob), AAD).toString('utf8');
}
