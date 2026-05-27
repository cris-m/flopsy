import type { Database as Db } from 'better-sqlite3';
import { wipe } from './crypto/kdf';
import { appendAudit } from './store/audit';
import { closeVaultDb, openVaultDb } from './store/db';
import { isVaultInitialised } from './store/meta';
import { getSecret, listSecrets } from './store/secrets';
import { unsealVault, VaultSealError } from './seal';

export class BrokerSealedError extends Error {
    constructor() {
        super('credential broker is sealed (call initBroker first)');
        this.name = 'BrokerSealedError';
    }
}

export class CredentialMissingError extends Error {
    constructor(name: string) {
        super(`credential not found in vault: ${name}`);
        this.name = 'CredentialMissingError';
    }
}

export interface GetCredentialOptions {
    who: string;
    fallbackToEnv?: boolean;
}

export class CredentialBroker {
    private dek: Buffer | undefined;
    private db: Db | undefined;
    private readonly path: string;
    private closed = false;

    constructor(path: string, db: Db, dek: Buffer) {
        this.path = path;
        this.db = db;
        this.dek = dek;
    }

    get(name: string, opts: GetCredentialOptions): string {
        if (this.closed || !this.dek || !this.db) throw new BrokerSealedError();
        try {
            const value = getSecret(this.db, this.dek, name);
            if (value !== undefined) {
                appendAudit(this.db, this.dek, {
                    actorToken: opts.who,
                    action: 'credential.read',
                    resource: name,
                    outcome: 'success',
                });
                return value;
            }
            if (opts.fallbackToEnv) {
                const env = process.env[name];
                if (env !== undefined && env.length > 0) {
                    appendAudit(this.db, this.dek, {
                        actorToken: opts.who,
                        action: 'credential.read',
                        resource: name,
                        outcome: 'fallback-env',
                    });
                    return env;
                }
            }
            appendAudit(this.db, this.dek, {
                actorToken: opts.who,
                action: 'credential.read',
                resource: name,
                outcome: 'denied:not-found',
            });
            throw new CredentialMissingError(name);
        } catch (err) {
            if (err instanceof CredentialMissingError) throw err;
            throw err;
        }
    }

    tryGet(name: string, opts: GetCredentialOptions): string | undefined {
        try {
            return this.get(name, opts);
        } catch (err) {
            if (err instanceof CredentialMissingError) return undefined;
            throw err;
        }
    }

    listNames(): string[] {
        if (this.closed || !this.db) throw new BrokerSealedError();
        return listSecrets(this.db).map((r) => r.name);
    }

    get dbPath(): string {
        return this.path;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.dek) wipe(this.dek);
        this.dek = undefined;
        if (this.db) closeVaultDb(this.db);
        this.db = undefined;
    }
}

let singleton: CredentialBroker | undefined;

export interface InitBrokerOptions {
    path: string;
    masterPassword: string;
}

export function initBroker(opts: InitBrokerOptions): CredentialBroker {
    const db = openVaultDb({ path: opts.path });
    if (!isVaultInitialised(db)) {
        closeVaultDb(db);
        throw new VaultSealError('vault not initialised — call initVault() first');
    }
    let dek: Buffer;
    try {
        dek = unsealVault(db, opts.masterPassword);
    } catch (err) {
        closeVaultDb(db);
        throw err;
    }
    const broker = new CredentialBroker(opts.path, db, dek);
    singleton = broker;
    return broker;
}

export function getBroker(): CredentialBroker | undefined {
    return singleton;
}

export function setBroker(broker: CredentialBroker | undefined): void {
    singleton = broker;
}

export function closeBroker(): void {
    if (singleton) {
        singleton.close();
        singleton = undefined;
    }
}
