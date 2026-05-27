import { CredentialBroker, initBroker } from '../broker';
import { pruneAudit } from '../store/audit';
import { listRules } from '../store/rules';
import { listSecrets } from '../store/secrets';
import { listTokens } from '../store/tokens';
import { startMgmtServer, type MgmtServerHandle } from './mgmt';
import { startProxyServer, type ProxyServerHandle } from './proxy';

const AUDIT_RETENTION_MS = 1000 * 60 * 60 * 24 * 30;
const AUDIT_PRUNE_INTERVAL_MS = 1000 * 60 * 60 * 6;

export interface VaultServerOptions {
    vaultDbPath: string;
    masterPassword: string;
    host?: string;
    mgmtPort?: number;
    proxyPort?: number;
}

export interface VaultServerHandle {
    broker: CredentialBroker;
    mgmt: MgmtServerHandle;
    proxy: ProxyServerHandle;
    stop: () => Promise<void>;
}

export async function startVaultServer(opts: VaultServerOptions): Promise<VaultServerHandle> {
    const host = opts.host ?? '127.0.0.1';
    const mgmtPort = opts.mgmtPort ?? 18791;
    const proxyPort = opts.proxyPort ?? 18792;

    const broker = initBroker({ path: opts.vaultDbPath, masterPassword: opts.masterPassword });
    const db = (broker as unknown as { db: import('better-sqlite3').Database }).db;

    const mgmt = await startMgmtServer({
        host,
        port: mgmtPort,
        getStatus: () => ({
            unsealed: true,
            secrets: listSecrets(db).length,
            tokens: listTokens(db).filter((t) => !t.revoked).length,
            rules: listRules(db).length,
        }),
    });

    const proxy = await startProxyServer({
        host,
        port: proxyPort,
        db,
        broker,
    });

    try { pruneAudit(db, AUDIT_RETENTION_MS); } catch { /* */ }
    const pruneTimer: NodeJS.Timeout = setInterval(() => {
        try { pruneAudit(db, AUDIT_RETENTION_MS); } catch { /* */ }
    }, AUDIT_PRUNE_INTERVAL_MS);
    pruneTimer.unref?.();

    return {
        broker,
        mgmt,
        proxy,
        stop: async () => {
            clearInterval(pruneTimer);
            await Promise.all([mgmt.close(), proxy.close()]);
            broker.close();
        },
    };
}

export { startMgmtServer, type MgmtServerHandle } from './mgmt';
export { startProxyServer, type ProxyServerHandle } from './proxy';
