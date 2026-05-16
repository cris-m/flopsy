export { newSalt, deriveKek, KDF_PARAMS, wipe } from './crypto/kdf';
export { seal, open, newKey, NONCE_BYTES, TAG_BYTES, KEY_BYTES } from './crypto/cipher';
export type { Sealed } from './crypto/cipher';
export { openVaultDb, closeVaultDb } from './store/db';
export {
    getMeta,
    putMeta,
    encodeSealed,
    decodeSealed,
    isVaultInitialised,
} from './store/meta';
export { putSecret, getSecret, listSecrets, deleteSecret } from './store/secrets';
export type { SecretRow } from './store/secrets';
export { initVault, unsealVault, changeMasterPassword, VaultSealError } from './seal';
export {
    CredentialBroker,
    BrokerSealedError,
    CredentialMissingError,
    initBroker,
    getBroker,
    setBroker,
    closeBroker,
    type GetCredentialOptions,
    type InitBrokerOptions,
} from './broker';
export { bootstrapVault, type VaultBootstrap, type BootstrapResult, type SkippedResult, type BootstrapOptions } from './bootstrap';
export { appendAudit, type AuditEntry } from './store/audit';
