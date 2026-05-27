import { existsSync } from 'node:fs';
import { CredentialBroker, initBroker } from './broker';
import { unsealVault, VaultSealError } from './seal';
import { closeVaultDb, openVaultDb } from './store/db';
import { isVaultInitialised } from './store/meta';
import { getSecret, listSecrets } from './store/secrets';
import { wipe } from './crypto/kdf';

export interface BootstrapResult {
    kind: 'unsealed';
    broker: CredentialBroker;
    hydrated: string[];
}

export interface SkippedResult {
    kind: 'skipped';
    reason: string;
}

export type VaultBootstrap = BootstrapResult | SkippedResult;

export interface BootstrapOptions {
    vaultDbPath: string;
    masterPassword?: string;
    overrideEnv?: boolean;
}

export function bootstrapVault(opts: BootstrapOptions): VaultBootstrap {
    if (!opts.masterPassword || opts.masterPassword.length === 0) {
        return { kind: 'skipped', reason: 'FLOPSY_VAULT_MASTER_PASSWORD not set' };
    }
    if (!existsSync(opts.vaultDbPath)) {
        return { kind: 'skipped', reason: 'vault.db does not exist' };
    }
    const probeDb = openVaultDb({ path: opts.vaultDbPath, readOnly: true });
    let initialised = false;
    try {
        initialised = isVaultInitialised(probeDb);
    } finally {
        closeVaultDb(probeDb);
    }
    if (!initialised) {
        return { kind: 'skipped', reason: 'vault.db exists but is not initialised' };
    }

    const broker = initBroker({ path: opts.vaultDbPath, masterPassword: opts.masterPassword });
    const hydrated: string[] = [];

    const readDb = openVaultDb({ path: opts.vaultDbPath, readOnly: true });
    const readDek = unsealVault(readDb, opts.masterPassword);
    try {
        const rows = listSecrets(readDb);
        for (const row of rows) {
            const current = process.env[row.name];
            const looksLikePlaceholder = typeof current === 'string' && /^__[a-z0-9_]+__$/i.test(current);
            const shouldOverride = opts.overrideEnv === true || looksLikePlaceholder || current === undefined || current === '';
            if (!shouldOverride) continue;
            const value = getSecret(readDb, readDek, row.name);
            if (value === undefined) continue;
            process.env[row.name] = value;
            hydrated.push(row.name);
        }
    } finally {
        wipe(readDek);
        closeVaultDb(readDb);
    }

    return { kind: 'unsealed', broker, hydrated };
}

export { VaultSealError };
