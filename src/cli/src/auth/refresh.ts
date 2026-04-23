/**
 * Single-call "give me a usable access token" helper.
 *
 * Used by the MCP loader (to inject up-to-date tokens into child
 * process envs before spawning) and by any runtime tool that needs a
 * live Bearer token. Refreshes transparently when expiry is near.
 *
 * Contract:
 *   - If no credential stored → throws (caller should tell user to run
 *     `flopsy auth <provider>`).
 *   - If token expires in > REFRESH_BUFFER_MS → return current, no-op.
 *   - If expires sooner → refresh via provider.refresh(), persist, return.
 *   - If refresh fails → throws with diagnostic. Caller decides whether
 *     to proceed without MCP server or surface to user.
 */

import { loadCredential } from './credential-store';
import { getProvider } from './providers/registry';
import type { StoredCredential } from './types';

/**
 * Refresh `REFRESH_BUFFER_MS` before expiry so no tool call lands on a
 * just-expired token. 5 minutes matches Google's typical clock-skew
 * tolerance and leaves headroom for a slow network.
 */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface GetValidCredentialOptions {
    /** Skip the refresh check — return whatever is on disk, expired or not. */
    readonly skipRefresh?: boolean;
}

export async function getValidCredential(
    providerName: string,
    opts: GetValidCredentialOptions = {},
): Promise<StoredCredential> {
    const current = loadCredential(providerName);
    if (!current) {
        throw new Error(
            `No credential for "${providerName}". Run \`flopsy auth ${providerName}\` to connect.`,
        );
    }
    if (opts.skipRefresh) return current;

    const remaining = current.expiresAt - Date.now();
    if (remaining > REFRESH_BUFFER_MS) return current;

    const provider = getProvider(providerName);
    if (!provider) {
        // Credential exists but the provider module isn't registered —
        // hand back what we have and let the caller fail fast with the
        // 401 from the service.
        return current;
    }

    try {
        return await provider.refresh(current);
    } catch (err) {
        throw new Error(
            `Credential for "${providerName}" is expired and refresh failed: ${
                err instanceof Error ? err.message : String(err)
            }\nRun \`flopsy auth ${providerName}\` to re-authorize.`,
        );
    }
}

/**
 * Return just the Bearer token. Convenience for code that doesn't need
 * the full credential (scopes, email, etc.).
 */
export async function getValidAccessToken(providerName: string): Promise<string> {
    const cred = await getValidCredential(providerName);
    return cred.accessToken;
}
