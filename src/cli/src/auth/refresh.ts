import { loadCredential } from './credential-store';
import { getProvider } from './providers/registry';
import { withCredentialLock } from './refresh-lock';
import type { StoredCredential } from './types';

// Refresh this far before expiry so no tool call lands on a just-expired token (clock skew + slow net).
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const GOOGLE_SERVICE_PROVIDERS = new Set(['gmail', 'drive', 'calendar', 'youtube', 'contacts']);

function loadWithLegacyFallback(providerName: string): StoredCredential | null {
    const direct = loadCredential(providerName);
    if (direct) return direct;
    if (GOOGLE_SERVICE_PROVIDERS.has(providerName)) return loadCredential('google');
    return null;
}

export interface GetValidCredentialOptions {
    readonly skipRefresh?: boolean;
}

export async function getValidCredential(
    providerName: string,
    opts: GetValidCredentialOptions = {},
): Promise<StoredCredential> {
    const current = loadWithLegacyFallback(providerName);
    if (!current) {
        throw new Error(
            `No credential for "${providerName}". Run \`flopsy auth ${providerName}\` to connect.`,
        );
    }
    if (opts.skipRefresh) return current;

    if (current.expiresAt - Date.now() > REFRESH_BUFFER_MS) return current;

    const provider = getProvider(current.provider) ?? getProvider(providerName);
    if (!provider) {
        // Provider module not registered — hand back the stale cred and let the 401 surface.
        return current;
    }

    try {
        // Lock on the credential's real provider (e.g. 'google'), not the requested alias, so all
        // writers to one file serialize; re-load inside in case a concurrent holder just refreshed.
        return await withCredentialLock(current.provider, async () => {
            const latest = loadCredential(current.provider) ?? current;
            if (latest.expiresAt - Date.now() > REFRESH_BUFFER_MS) return latest;
            return provider.refresh(latest);
        });
    } catch (err) {
        throw new Error(
            `Credential for "${providerName}" is expired and refresh failed: ${
                err instanceof Error ? err.message : String(err)
            }\nRun \`flopsy auth ${providerName}\` to re-authorize.`,
        );
    }
}

export interface RefreshNowOptions {
    // Skip if a concurrent holder already refreshed within this much runway; omit to force.
    readonly skipIfFresherThanMs?: number;
}

export async function refreshCredentialNow(
    providerName: string,
    opts: RefreshNowOptions = {},
): Promise<StoredCredential> {
    const current = loadWithLegacyFallback(providerName);
    if (!current) {
        throw new Error(
            `No credential for "${providerName}". Run \`flopsy auth ${providerName}\` to connect.`,
        );
    }
    const provider = getProvider(current.provider) ?? getProvider(providerName);
    if (!provider) {
        throw new Error(`No auth provider registered for "${providerName}".`);
    }
    return withCredentialLock(current.provider, async () => {
        const latest = loadCredential(current.provider) ?? current;
        if (
            opts.skipIfFresherThanMs != null &&
            latest.expiresAt - Date.now() > opts.skipIfFresherThanMs
        ) {
            return latest;
        }
        return provider.refresh(latest);
    });
}

export function isInvalidGrant(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /invalid_grant|invalid_token|unauthorized_client|token (has been expired or )?revoked|refresh token[^.]*(expired|revoked|invalid)/i.test(
        msg,
    );
}

export async function getValidAccessToken(providerName: string): Promise<string> {
    const cred = await getValidCredential(providerName);
    return cred.accessToken;
}
