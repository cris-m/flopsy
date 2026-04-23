/**
 * Shared Spotify auth helper for the `spotify.ts` MCP server. Mirrors the
 * `google-auth.ts` pattern:
 *
 *   1. Read the credentials the gateway's MCP loader injected via
 *      `requiresAuth: ["spotify"]`:
 *        SPOTIFY_ACCESS_TOKEN     (always)
 *        SPOTIFY_REFRESH_TOKEN    (when available)
 *        SPOTIFY_EXPIRES_AT       (ms epoch)
 *        SPOTIFY_CLIENT_ID        (from process.env / .env)
 *
 *   2. Return a valid access token on demand — refreshes in-process when
 *      the token is within 60s of expiry and persists the new token back
 *      to `<FLOPSY_HOME>/auth/spotify.json` so sibling MCP spawns see it.
 *
 *   3. Fail fast (exit code 2) if no credential is available — retrying
 *      wouldn't help; the user needs to run `flopsy auth spotify` once.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { workspace } from '@flopsy/shared';

const EXIT_CONFIG_BROKEN = 2;
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

interface StoredToken {
    accessToken: string;
    refreshToken: string | undefined;
    expiresAt: number;
}

/** In-memory state — refreshed on each `getValidAccessToken` call as needed. */
let state: StoredToken | null = null;

function readFromEnv(): StoredToken {
    const accessToken = process.env.SPOTIFY_ACCESS_TOKEN;
    if (!accessToken) {
        console.error(
            '[spotify-mcp] SPOTIFY_ACCESS_TOKEN not set. ' +
                'Run `flopsy auth spotify` first.',
        );
        process.exit(EXIT_CONFIG_BROKEN);
    }
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) {
        console.error(
            '[spotify-mcp] SPOTIFY_CLIENT_ID not set. ' +
                'Put it in .env so in-process token refresh can work.',
        );
        process.exit(EXIT_CONFIG_BROKEN);
    }
    return {
        accessToken,
        refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
        expiresAt: Number(process.env.SPOTIFY_EXPIRES_AT) || 0,
    };
}

function credentialPath(): string {
    return `${workspace.root()}/auth/spotify.json`;
}

/**
 * Persist a refreshed credential back to `.flopsy/auth/spotify.json` so
 * the gateway and sibling MCP spawns pick up the new access_token on
 * their next read. Atomic rename to avoid half-written files on crash.
 */
function persistRefreshedToken(next: StoredToken): void {
    const path = credentialPath();
    if (!existsSync(path)) return;
    try {
        const raw = readFileSync(path, 'utf-8');
        const cred = JSON.parse(raw) as Record<string, unknown>;
        cred['accessToken'] = next.accessToken;
        cred['expiresAt'] = next.expiresAt;
        if (next.refreshToken) cred['refreshToken'] = next.refreshToken;
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
        renameSync(tmp, path);
    } catch (err) {
        // Best-effort — we still return the in-process refreshed token.
        console.error(
            '[spotify-mcp] failed to persist refreshed token:',
            err instanceof Error ? err.message : err,
        );
    }
}

async function refreshAccessToken(current: StoredToken): Promise<StoredToken> {
    if (!current.refreshToken) {
        throw new Error(
            'No Spotify refresh_token available. Re-run `flopsy auth spotify`.',
        );
    }
    const clientId = process.env.SPOTIFY_CLIENT_ID!;
    const body = new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
    });
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!res.ok) {
        throw new Error(
            `Spotify refresh endpoint ${res.status}: ${await res.text()}`,
        );
    }
    const json = (await res.json()) as {
        access_token: string;
        expires_in: number;
        refresh_token?: string;
    };
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? current.refreshToken,
        expiresAt: Date.now() + json.expires_in * 1000,
    };
}

/**
 * Main entry for the MCP server — return a valid access token, refreshing
 * from disk if the stored one is past its expiry (with 60s headroom).
 * Throws with an actionable message if no credential is available.
 */
export async function getValidAccessToken(): Promise<string> {
    if (!state) state = readFromEnv();
    if (state.expiresAt > Date.now() + 60_000) return state.accessToken;
    const next = await refreshAccessToken(state);
    state = next;
    persistRefreshedToken(next);
    return next.accessToken;
}
