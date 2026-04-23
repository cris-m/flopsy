/**
 * Shared Google OAuth client for the gmail / calendar / drive MCP
 * servers. Responsible for:
 *
 *   1. Reading the credentials the gateway's MCP loader injected:
 *        GOOGLE_ACCESS_TOKEN     (always)
 *        GOOGLE_REFRESH_TOKEN    (when available)
 *        GOOGLE_EXPIRES_AT       (ms epoch)
 *        GOOGLE_CLIENT_ID        (from process.env / .env)
 *        GOOGLE_CLIENT_SECRET    (from process.env / .env)
 *
 *   2. Building an `OAuth2` client pre-configured so `googleapis` can
 *      refresh in-process when the access token expires — no gateway
 *      round-trip needed. This is "Tier B" in our auth design notes.
 *
 *   3. Persisting refreshed tokens back to the credential store so
 *      other MCP instances and the gateway see the latest access_token.
 *
 *   4. A process-level 401 catcher that exits with a distinct code
 *      (1 = retry, 2 = config broken) so we never loop on a revoked
 *      refresh token.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { workspace } from '@flopsy/shared';

/** Exit codes the gateway interprets (once respawn lands). */
const EXIT_RETRY = 1;
const EXIT_CONFIG_BROKEN = 2;

/**
 * Resolve credentials from the environment. Throws (and exits with
 * code 2) when anything required is missing, because the MCP can't do
 * its job without auth — retrying wouldn't help.
 */
function readEnvCredential(): {
    accessToken: string;
    refreshToken: string | undefined;
    expiresAt: number;
    clientId: string;
    clientSecret: string;
} {
    const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
    if (!accessToken) {
        console.error(
            '[google-mcp] GOOGLE_ACCESS_TOKEN not set. Run `flopsy auth google` first.',
        );
        process.exit(EXIT_CONFIG_BROKEN);
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        console.error(
            '[google-mcp] GOOGLE_CLIENT_ID / _CLIENT_SECRET not set. ' +
                'Put them in .env so in-process token refresh can work.',
        );
        process.exit(EXIT_CONFIG_BROKEN);
    }
    return {
        accessToken,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        expiresAt: Number(process.env.GOOGLE_EXPIRES_AT) || 0,
        clientId,
        clientSecret,
    };
}

/**
 * Path to the credential file the CLI's `flopsy auth` writes. Delegated
 * to the shared `workspace` helper so wherever FLOPSY_HOME points
 * (absolute, relative, ~/ prefix, profile-based), we read + write to
 * the same location the rest of the stack uses.
 *
 * Note: our CLI's credential-store lives under `<workspace>/auth/`,
 * not `<workspace>/credentials/`, so we join 'auth' explicitly here.
 */
function credentialPath(provider: string): string {
    return workspace.root() + '/auth/' + provider + '.json';
}

/**
 * Write the refreshed access token back to the shared credential file
 * so the gateway and sibling MCP processes see it on their next read.
 * Atomic rename to avoid a half-written file if we crash mid-write.
 */
function persistRefreshedToken(nextAccessToken: string, nextExpiryMs: number): void {
    const path = credentialPath('google');
    if (!existsSync(path)) return; // nothing to merge into
    try {
        const raw = readFileSync(path, 'utf-8');
        const cred = JSON.parse(raw) as { accessToken: string; expiresAt: number };
        cred.accessToken = nextAccessToken;
        cred.expiresAt = nextExpiryMs;
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
        renameSync(tmp, path);
    } catch (err) {
        // Best-effort — if persistence fails we still return the in-process
        // refreshed token to the caller. Gateway will refresh on next spawn.
        console.error(
            '[google-mcp] failed to persist refreshed token:',
            err instanceof Error ? err.message : err,
        );
    }
}

/**
 * Build the shared OAuth2 client. Called once at MCP-server startup;
 * the returned client is passed to every `google.gmail / calendar /
 * drive` factory so every API call inherits the refresh behavior.
 *
 * `googleapis` emits a `tokens` event whenever it refreshes — we hook
 * it to write the new access_token back to disk.
 */
export function createAuth(): OAuth2Client {
    const cred = readEnvCredential();
    const auth = new google.auth.OAuth2(cred.clientId, cred.clientSecret);
    auth.setCredentials({
        access_token: cred.accessToken,
        refresh_token: cred.refreshToken,
        expiry_date: cred.expiresAt || undefined,
    });
    auth.on('tokens', (t) => {
        if (t.access_token) {
            const nextExpiry = t.expiry_date ?? Date.now() + 3_600_000;
            persistRefreshedToken(t.access_token, nextExpiry);
        }
    });
    return auth;
}

/**
 * Belt-and-braces: catch any 401 that escapes googleapis' automatic
 * refresh+retry (e.g. refresh_token revoked, scope missing) and exit
 * cleanly so the spawn manager surfaces the error to the user rather
 * than hanging in a broken state.
 */
export function installAuthErrorHandler(): void {
    const handle = (err: unknown): void => {
        const anyErr = err as { code?: number | string; response?: { status?: number } };
        const code = anyErr.code ?? anyErr.response?.status;
        if (code === 401 || code === '401') {
            console.error(
                '[google-mcp] 401 after refresh attempt — token likely revoked. ' +
                    'Run `flopsy auth google` to re-authorize.',
            );
            process.exit(EXIT_RETRY);
        }
    };
    process.on('unhandledRejection', handle);
    process.on('uncaughtException', handle);
}
