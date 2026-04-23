/**
 * Spotify OAuth 2.0 + PKCE — Web API (search, playback, library, playlists).
 *
 * Flow:
 *   1. Generate PKCE verifier/challenge + state nonce
 *   2. Open a local callback listener on the port/path specified by
 *      `mcp.servers.spotify.redirectBase` in flopsy.json5 (fixed, not
 *      random — Spotify requires the redirect URI to match exactly what's
 *      registered in the developer dashboard)
 *   3. Open browser to Spotify's authorize URL
 *   4. User approves → Spotify redirects with `code`
 *   5. Exchange code + verifier for tokens (no client_secret — PKCE)
 *   6. Save credential to `<FLOPSY_HOME>/auth/spotify.json`
 *
 * Client credentials:
 *   Only SPOTIFY_CLIENT_ID needed — PKCE replaces client_secret per
 *   Spotify's recommended flow for desktop/CLI apps.
 */

import { loadConfig } from '@flopsy/shared';
import {
    awaitOauthCallback,
    type CallbackResult,
} from '../callback-server';
import { openInBrowser } from '../browser';
import { saveCredential } from '../credential-store';
import { generatePkcePair, generateState } from '../pkce';
import type {
    AuthProvider,
    AuthorizeOptions,
    StoredCredential,
} from '../types';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const USERINFO_URL = 'https://api.spotify.com/v1/me';

/**
 * Default scope bundle — matches what the MCP server actually uses
 * (search, playback, queue, library, playlists, top items, recently played).
 */
const DEFAULT_SCOPES: readonly string[] = [
    'user-read-private',
    'user-read-email',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'user-read-recently-played',
    'user-library-read',
    'user-library-modify',
    'playlist-read-private',
    'playlist-read-collaborative',
    'playlist-modify-private',
    'playlist-modify-public',
    'user-top-read',
];

/** Fallback redirect URI when flopsy.json5 is missing or lacks a value. */
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8888/spotify';

interface ParsedRedirect {
    readonly uri: string;
    readonly port: number;
    readonly path: string;
}

/**
 * Read the full redirect URI from flopsy.json5's
 * `mcp.servers.spotify.redirectBase` field and parse it into the
 * port/path that the local callback server needs. Falls back to the
 * loopback default if the config is missing.
 */
function readRedirect(): ParsedRedirect {
    let uri = DEFAULT_REDIRECT_URI;
    try {
        const cfg = loadConfig();
        const spotify = cfg.mcp?.servers?.['spotify'] as { redirectBase?: string } | undefined;
        const fromConfig = spotify?.redirectBase?.trim();
        if (fromConfig) uri = fromConfig;
    } catch {
        /* config missing — fall back to default */
    }
    const parsed = new URL(uri);
    return {
        uri,
        port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname || '/',
    };
}

function requireClientId(): string {
    const id = process.env['SPOTIFY_CLIENT_ID']?.trim();
    if (!id) {
        throw new Error(
            'SPOTIFY_CLIENT_ID is not set.\n' +
                '  1. Create an app at https://developer.spotify.com/dashboard\n' +
                '  2. Set the Redirect URI (from flopsy.json5 redirectBase)\n' +
                '  3. Copy the Client ID, put it in .env: SPOTIFY_CLIENT_ID=...\n' +
                '  4. Re-run `flopsy auth spotify`\n',
        );
    }
    return id;
}

interface SpotifyTokenResponse {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    scope?: string;
    token_type: string;
}

interface SpotifyUserInfo {
    id: string;
    email?: string;
    display_name?: string;
}

async function postTokens(params: URLSearchParams): Promise<SpotifyTokenResponse> {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });
    if (!res.ok) {
        const detail = await res.text();
        throw new Error(
            `Spotify token endpoint returned ${res.status}: ${detail.slice(0, 500)}`,
        );
    }
    return (await res.json()) as SpotifyTokenResponse;
}

async function fetchUserinfo(accessToken: string): Promise<SpotifyUserInfo | null> {
    try {
        const res = await fetch(USERINFO_URL, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) return null;
        return (await res.json()) as SpotifyUserInfo;
    } catch {
        return null;
    }
}

export const spotifyProvider: AuthProvider = {
    name: 'spotify',
    displayName: 'Spotify (playback, library, playlists)',
    defaultScopes: DEFAULT_SCOPES,

    async authorize(opts: AuthorizeOptions = {}): Promise<StoredCredential> {
        const clientId = requireClientId();
        const scopes = opts.scopes?.length
            ? [...new Set([...DEFAULT_SCOPES, ...opts.scopes])]
            : DEFAULT_SCOPES;

        const { uri: configuredRedirect, port, path } = readRedirect();
        const pkce = generatePkcePair();
        const state = generateState();

        // Spotify requires redirect_uri to match the dashboard registration
        // byte-for-byte. We bind the listener to the port/path parsed from
        // the configured URI — not `preferredPort: 0` like Google — so the
        // loopback URL we pass is exactly `configuredRedirect`.
        const { redirectUri, result } = await awaitOauthCallback({
            preferredPort: port,
            path,
        });
        if (redirectUri !== configuredRedirect) {
            // The callback server always builds URIs as `http://127.0.0.1:<port><path>`,
            // so this fires if the user configured a non-loopback host in
            // flopsy.json5 (we bind to 127.0.0.1 — HTTPS / tunnels not supported).
            throw new Error(
                `Spotify redirect URI mismatch:\n` +
                    `  configured (flopsy.json5): ${configuredRedirect}\n` +
                    `  listener bound:            ${redirectUri}\n` +
                    `Set "redirectBase" to a http://127.0.0.1:<port>/<path> URL.`,
            );
        }

        const authorizeUrl = new URL(AUTHORIZE_URL);
        authorizeUrl.searchParams.set('client_id', clientId);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('redirect_uri', configuredRedirect);
        authorizeUrl.searchParams.set('scope', scopes.join(' '));
        authorizeUrl.searchParams.set('state', state);
        authorizeUrl.searchParams.set('code_challenge', pkce.codeChallenge);
        authorizeUrl.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);

        const authorizeUrlStr = authorizeUrl.toString();
        console.log(`\nRedirect URI: ${configuredRedirect}`);
        console.log(`  ↳ must match exactly in your Spotify app dashboard.\n`);
        console.log(`Open the following URL to authorize Spotify:\n\n  ${authorizeUrlStr}\n`);
        if (!opts.noOpen) {
            openInBrowser(authorizeUrlStr);
        }
        console.log('Waiting for callback...');

        const cb: CallbackResult = await result;
        if (cb.state !== state) {
            throw new Error(
                'OAuth state mismatch — aborting. Likely a stale browser tab tried to complete the flow.',
            );
        }

        const tokenParams = new URLSearchParams({
            client_id: clientId,
            grant_type: 'authorization_code',
            code: cb.code,
            redirect_uri: configuredRedirect,
            code_verifier: pkce.codeVerifier,
        });

        const tokens = await postTokens(tokenParams);
        const userinfo = await fetchUserinfo(tokens.access_token);

        const now = Date.now();
        const cred: StoredCredential = {
            provider: 'spotify',
            tokenType: tokens.token_type || 'Bearer',
            accessToken: tokens.access_token,
            ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
            expiresAt: now + tokens.expires_in * 1000,
            scopes: tokens.scope ? tokens.scope.split(' ') : [...scopes],
            ...(userinfo?.email ? { email: userinfo.email } : {}),
            ...(userinfo?.display_name ? { displayName: userinfo.display_name } : {}),
            meta: {
                clientIdSuffix: clientId.slice(-8),
                ...(userinfo?.id ? { spotifyId: userinfo.id } : {}),
            },
            authorizedAt: now,
        };

        saveCredential(cred);
        return cred;
    },

    async refresh(current: StoredCredential): Promise<StoredCredential> {
        if (!current.refreshToken) {
            throw new Error(
                'Credential has no refresh_token. Re-run `flopsy auth spotify` to reauthorize.',
            );
        }
        const clientId = requireClientId();
        const params = new URLSearchParams({
            client_id: clientId,
            grant_type: 'refresh_token',
            refresh_token: current.refreshToken,
        });
        const tokens = await postTokens(params);
        const now = Date.now();
        const refreshed: StoredCredential = {
            ...current,
            accessToken: tokens.access_token,
            // Spotify usually keeps the old refresh_token valid; preserve
            // it if the response omits a new one.
            refreshToken: tokens.refresh_token ?? current.refreshToken,
            expiresAt: now + tokens.expires_in * 1000,
            scopes: tokens.scope ? tokens.scope.split(' ') : current.scopes,
        };
        saveCredential(refreshed);
        return refreshed;
    },

    // No revoke — Spotify doesn't expose a token revocation endpoint.
    // `flopsy auth revoke spotify` will still delete the local credential.
};
