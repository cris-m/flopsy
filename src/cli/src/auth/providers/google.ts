/**
 * Google OAuth 2.0 + PKCE — Gmail, Calendar, Drive, Contacts, Tasks.
 *
 * Flow:
 *   1. Generate PKCE verifier/challenge + state nonce
 *   2. Spin up a localhost callback listener on a random port
 *   3. Open the browser to the Google consent screen
 *   4. User approves → Google redirects to our callback with `code`
 *   5. Exchange code + verifier for tokens
 *   6. Fetch userinfo for email display
 *   7. Save credential to `<FLOPSY_HOME>/auth/google.json`
 *
 * Client credentials:
 *   Google's "Desktop app" OAuth client type issues a client_id AND a
 *   client_secret, but the secret is NOT confidential — any shipped CLI
 *   can extract it. PKCE is what secures the flow. We require the user
 *   to provide a client_id via env var (see README for a 5-minute setup
 *   in Google Cloud Console) to avoid policy ambiguity around
 *   redistributing OAuth client IDs we didn't register.
 */

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

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
// Device flow (RFC 8628) — separate Google client type "TV/Limited Input".
// Distinct from the Desktop client used for CLI's localhost callback flow.
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const DEVICE_VERIFICATION_URL = 'https://www.google.com/device';

/**
 * DEFAULT_SCOPES — the broad set for the CLI OAuth flow (Desktop OAuth
 * client type). Includes `gmail.modify` (trash/delete), `drive.readonly`
 * (list user's existing files). These require the user's OAuth consent
 * screen in Google Cloud Console to have those scopes added under
 * "Scopes for Google APIs", otherwise Google returns `invalid_scope`.
 */
const DEFAULT_SCOPES: readonly string[] = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
];

/**
 * DEVICE_FLOW_SCOPES — the narrow set the in-chat `connect_service` uses
 * by default. Matches what has been proven to work with Google's
 * "TVs and Limited Input devices" OAuth client type + the user's current
 * consent-screen registration. DO NOT add scopes here without confirming
 * they are (a) on Google's device-flow allowlist AND (b) added to the
 * consent screen — otherwise device flow fails with `invalid_scope` and
 * the user sees a cryptic "scope settings issue" message. If the user
 * wants broader scopes (delete, list existing Drive files), they should
 * run `flopsy auth google` from the CLI (Desktop client, broader allowlist).
 */
const DEVICE_FLOW_SCOPES: readonly string[] = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive.file',
];

function requireClientId(): string {
    const id = process.env['GOOGLE_CLIENT_ID']?.trim();
    if (!id) {
        throw new Error(
            'GOOGLE_CLIENT_ID is not set.\n' +
                '  1. Visit https://console.cloud.google.com/apis/credentials\n' +
                '  2. Create OAuth client ID → Application type: "Desktop app"\n' +
                '  3. Copy the client ID, export GOOGLE_CLIENT_ID=...\n' +
                '  4. (Optional) GOOGLE_CLIENT_SECRET=... if Google requires it\n' +
                '  5. Re-run `flopsy auth google`\n',
        );
    }
    return id;
}

/** Optional; Google desktop-app clients accept the secret but don't require it with PKCE. */
function optionalClientSecret(): string | undefined {
    const sec = process.env['GOOGLE_CLIENT_SECRET']?.trim();
    return sec && sec.length > 0 ? sec : undefined;
}

/**
 * MUST be a "TVs and Limited Input devices" OAuth client type — NOT the
 * Desktop App client in GOOGLE_CLIENT_ID.
 *
 * Despite the "Limited Input" name, Google DOES issue and require a
 * client_secret for these clients at the token exchange step. Download
 * the client JSON from Google Cloud Console — it contains both fields.
 *
 * Setup (one-time, ~3 minutes):
 *   1. https://console.cloud.google.com/apis/credentials
 *   2. Create OAuth client ID → Application type: "TVs and Limited Input devices"
 *   3. Download the JSON → set GOOGLE_DEVICE_CLIENT_ID and GOOGLE_DEVICE_CLIENT_SECRET
 *   (Do NOT reuse GOOGLE_CLIENT_ID/SECRET — separate credential pair.)
 */
function requireDeviceClientId(): string {
    const id = process.env['GOOGLE_DEVICE_CLIENT_ID']?.trim();
    if (!id) {
        throw new Error(
            'GOOGLE_DEVICE_CLIENT_ID is not set.\n' +
                '  1. Visit https://console.cloud.google.com/apis/credentials\n' +
                '  2. Create OAuth client ID → "TVs and Limited Input devices"\n' +
                '  3. Download the JSON, add to .env:\n' +
                '       GOOGLE_DEVICE_CLIENT_ID=...\n' +
                '       GOOGLE_DEVICE_CLIENT_SECRET=...\n' +
                '  4. Retry the in-chat connect',
        );
    }
    return id;
}

/** Google requires client_secret even for TV/Limited-Input clients (issued in the client JSON). */
function requireDeviceClientSecret(): string {
    const sec = process.env['GOOGLE_DEVICE_CLIENT_SECRET']?.trim();
    if (!sec) {
        throw new Error(
            'GOOGLE_DEVICE_CLIENT_SECRET is not set.\n' +
                '  Download the TV/Limited-Input OAuth client JSON from Google Cloud Console\n' +
                '  and add GOOGLE_DEVICE_CLIENT_SECRET=... to .env.',
        );
    }
    return sec;
}

export interface DeviceFlowStart {
    /** Code the user copies into the browser. */
    readonly userCode: string;
    /** URL the user opens (always https://www.google.com/device for Google). */
    readonly verificationUrl: string;
    /** Same URL with the user_code pre-filled — friendlier on mobile. */
    readonly verificationUrlComplete?: string;
    /** Opaque token the poller exchanges for an access_token. */
    readonly deviceCode: string;
    /** Seconds between poll attempts (Google enforces; we honour). */
    readonly intervalSeconds: number;
    /** Wall-clock unix-ms when the device_code is no longer redeemable. */
    readonly expiresAt: number;
}

interface GoogleDeviceCodeResponse {
    device_code: string;
    user_code: string;
    expires_in: number;
    interval: number;
    verification_url: string;
    verification_url_complete?: string;
}

export interface DeviceFlowPollResult {
    /** When the user has approved and the token exchange succeeded. */
    readonly status: 'success';
    readonly credential: StoredCredential;
}
export interface DeviceFlowPollPending {
    readonly status: 'pending';
    /** Caller should retry after this many seconds (Google may bump it). */
    readonly intervalSeconds: number;
}
export interface DeviceFlowPollExpired {
    readonly status: 'expired';
}
export interface DeviceFlowPollDenied {
    readonly status: 'denied';
}
/**
 * Non-terminal OAuth-level error with actionable detail. Distinct from
 * `denied` (user explicitly refused on the phone) — this is for
 * invalid_grant / invalid_client / invalid_scope / unauthorized_client
 * and other config-level errors where the user may have done their part
 * correctly but our OAuth client setup is wrong.
 */
export interface DeviceFlowPollError {
    readonly status: 'error';
    readonly errorDetail: string;
}
export type DeviceFlowPoll =
    | DeviceFlowPollResult
    | DeviceFlowPollPending
    | DeviceFlowPollExpired
    | DeviceFlowPollDenied
    | DeviceFlowPollError;

interface GoogleTokenResponse {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    scope: string;
    token_type: string;
    id_token?: string;
}

interface GoogleUserInfo {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    given_name?: string;
    family_name?: string;
    picture?: string;
    locale?: string;
}

async function fetchTokens(params: URLSearchParams): Promise<GoogleTokenResponse> {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });
    if (!res.ok) {
        const detail = await res.text();
        throw new Error(
            `Google token endpoint returned ${res.status}: ${detail.slice(0, 500)}`,
        );
    }
    return (await res.json()) as GoogleTokenResponse;
}

async function fetchUserinfo(accessToken: string): Promise<GoogleUserInfo | null> {
    try {
        const res = await fetch(USERINFO_URL, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) return null;
        return (await res.json()) as GoogleUserInfo;
    } catch {
        return null;
    }
}

export const googleProvider: AuthProvider = {
    name: 'google',
    displayName: 'Google (Gmail, Calendar, Drive)',
    defaultScopes: DEFAULT_SCOPES,

    async authorize(opts: AuthorizeOptions = {}): Promise<StoredCredential> {
        const clientId = requireClientId();
        const clientSecret = optionalClientSecret();
        const scopes = opts.scopes?.length
            ? [...new Set([...DEFAULT_SCOPES, ...opts.scopes])]
            : DEFAULT_SCOPES;

        const pkce = generatePkcePair();
        const state = generateState();

        const { redirectUri, result } = await awaitOauthCallback({
            preferredPort: opts.callbackPort,
        });

        const authorizeUrl = new URL(AUTHORIZE_URL);
        authorizeUrl.searchParams.set('client_id', clientId);
        authorizeUrl.searchParams.set('redirect_uri', redirectUri);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('scope', scopes.join(' '));
        authorizeUrl.searchParams.set('state', state);
        authorizeUrl.searchParams.set('code_challenge', pkce.codeChallenge);
        authorizeUrl.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
        // access_type=offline tells Google to return a refresh_token; without
        // this we only get a 1-hour access_token and have to re-prompt.
        authorizeUrl.searchParams.set('access_type', 'offline');
        // prompt=consent forces the consent screen on every authorization so
        // scopes get reviewed cleanly on re-auth (otherwise Google silently
        // returns the old scope set).
        authorizeUrl.searchParams.set('prompt', 'consent');

        const authorizeUrlStr = authorizeUrl.toString();

        // Print the URL FIRST so the user can copy/paste if the browser
        // doesn't open automatically (headless server, WSL, etc.).
        console.log(`\nOpen the following URL to authorize Google:\n\n  ${authorizeUrlStr}\n`);
        if (!opts.noOpen) {
            openInBrowser(authorizeUrlStr);
        }
        console.log('Waiting for callback...');

        const cb: CallbackResult = await result;
        if (cb.state !== state) {
            throw new Error(
                'OAuth state mismatch — aborting. This usually means a stale browser tab tried to complete the flow.',
            );
        }

        const tokenParams = new URLSearchParams({
            client_id: clientId,
            code: cb.code,
            code_verifier: pkce.codeVerifier,
            grant_type: 'authorization_code',
            redirect_uri: cb.redirectUri,
        });
        if (clientSecret) tokenParams.set('client_secret', clientSecret);

        const tokens = await fetchTokens(tokenParams);
        const userinfo = await fetchUserinfo(tokens.access_token);

        const now = Date.now();
        const cred: StoredCredential = {
            provider: 'google',
            tokenType: tokens.token_type || 'Bearer',
            accessToken: tokens.access_token,
            ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
            expiresAt: now + tokens.expires_in * 1000,
            scopes: tokens.scope ? tokens.scope.split(' ') : [...scopes],
            ...(userinfo?.email ? { email: userinfo.email } : {}),
            ...(userinfo?.name ? { displayName: userinfo.name } : {}),
            meta: {
                clientIdSuffix: clientId.slice(-8),
                ...(tokens.id_token ? { hasIdToken: true } : {}),
            },
            authorizedAt: now,
        };

        saveCredential(cred);
        return cred;
    },

    async refresh(current: StoredCredential): Promise<StoredCredential> {
        if (!current.refreshToken) {
            throw new Error(
                'Credential has no refresh_token. Re-run `flopsy auth google` to reauthorize.',
            );
        }
        const clientId = requireClientId();
        const clientSecret = optionalClientSecret();

        const params = new URLSearchParams({
            client_id: clientId,
            refresh_token: current.refreshToken,
            grant_type: 'refresh_token',
        });
        if (clientSecret) params.set('client_secret', clientSecret);

        const tokens = await fetchTokens(params);
        const now = Date.now();
        const refreshed: StoredCredential = {
            ...current,
            accessToken: tokens.access_token,
            // Google usually omits a new refresh_token on refresh — keep ours.
            refreshToken: tokens.refresh_token ?? current.refreshToken,
            expiresAt: now + tokens.expires_in * 1000,
            // Scope string is sometimes returned narrower than requested on refresh;
            // keep the original scope list for display sanity.
            scopes: tokens.scope ? tokens.scope.split(' ') : current.scopes,
        };
        saveCredential(refreshed);
        return refreshed;
    },

    async revoke(current: StoredCredential): Promise<void> {
        // (revoke implementation below)
        await revokeImpl(current);
    },
};

// Device flow exported separately so the in-chat connect_service tool can
// reach for it without going through the full AuthProvider interface
// (which is shaped for callback-based flows).
export const googleDeviceFlow = {
    /**
     * Initiate device flow: ask Google for a user_code + device_code.
     * Caller shows the user_code to the user; they enter it at
     * https://www.google.com/device on any device. Caller polls below.
     */
    async start(scopes: readonly string[] = DEVICE_FLOW_SCOPES): Promise<DeviceFlowStart> {
        const clientId = requireDeviceClientId();
        const params = new URLSearchParams({
            client_id: clientId,
            scope: scopes.join(' '),
        });
        const res = await fetch(DEVICE_CODE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        });
        if (!res.ok) {
            const detail = await res.text();
            // Parse invalid_scope to give the caller an actionable message
            // instead of raw RFC-6749 JSON. The most common cause is a scope
            // not being registered on the OAuth consent screen OR not being
            // on Google's device-flow allowlist.
            let humanDetail = detail.slice(0, 500);
            try {
                const parsed = JSON.parse(detail) as { error?: string; error_description?: string };
                if (parsed.error === 'invalid_scope') {
                    humanDetail =
                        `invalid_scope — one of the requested scopes is not approved on the ` +
                        `"TVs and Limited Input" OAuth client's consent screen, or is not on ` +
                        `Google's device-flow allowlist. Requested scopes: ${scopes.join(', ')}. ` +
                        `Raw: ${parsed.error_description ?? ''}`;
                }
            } catch { /* non-JSON body, keep the raw slice */ }
            throw new Error(`Google device-code endpoint returned ${res.status}: ${humanDetail}`);
        }
        const data = (await res.json()) as GoogleDeviceCodeResponse;
        return {
            userCode: data.user_code,
            verificationUrl: data.verification_url ?? DEVICE_VERIFICATION_URL,
            ...(data.verification_url_complete
                ? { verificationUrlComplete: data.verification_url_complete }
                : {}),
            deviceCode: data.device_code,
            intervalSeconds: Math.max(1, data.interval),
            expiresAt: Date.now() + data.expires_in * 1000,
        };
    },

    /**
     * Poll the token endpoint ONCE. Returns 'pending' while the user
     * hasn't entered the code yet, 'expired' / 'denied' on terminal
     * failure, 'success' with the saved credential on completion.
     *
     * Caller should sleep for `result.intervalSeconds` between pending
     * polls — Google may bump the interval via slow_down errors.
     */
    async poll(deviceCode: string, scopes: readonly string[] = DEVICE_FLOW_SCOPES): Promise<DeviceFlowPoll> {
        const clientId = requireDeviceClientId();
        const clientSecret = requireDeviceClientSecret();
        const params = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });

        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        });
        const body = (await res.json()) as
            | GoogleTokenResponse
            | { error: string; error_description?: string; interval?: number };

        if (res.ok && 'access_token' in body) {
            const tokens = body;
            const userinfo = await fetchUserinfo(tokens.access_token);
            const now = Date.now();
            const cred: StoredCredential = {
                provider: 'google',
                tokenType: tokens.token_type || 'Bearer',
                ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
                accessToken: tokens.access_token,
                expiresAt: now + tokens.expires_in * 1000,
                scopes: tokens.scope ? tokens.scope.split(' ') : [...scopes],
                ...(userinfo?.email ? { email: userinfo.email } : {}),
                ...(userinfo?.name ? { displayName: userinfo.name } : {}),
                meta: { authMethod: 'device-flow', clientIdSuffix: clientId.slice(-8) },
                authorizedAt: now,
            };
            saveCredential(cred);
            return { status: 'success', credential: cred };
        }

        const errBody = body as { error?: string; error_description?: string };
        const error = errBody.error ?? 'unknown';
        const errDesc = errBody.error_description ?? '';
        if (error === 'authorization_pending') {
            return { status: 'pending', intervalSeconds: 5 };
        }
        if (error === 'slow_down') {
            // Google asking us to back off — bump interval by 5s next time.
            return { status: 'pending', intervalSeconds: 10 };
        }
        if (error === 'expired_token') return { status: 'expired' };
        if (error === 'access_denied') return { status: 'denied' };

        // Any other OAuth error (invalid_grant, invalid_client, invalid_scope,
        // unauthorized_client, ...). Previously ALL mapped to `denied` which
        // lost the information — a user who completed auth on their phone but
        // hit a client-config error would see "Authorization denied" with no
        // way to diagnose. Return `error` status with real text so the caller
        // can relay the exact OAuth error back to logs + user.
        const detail = errDesc ? `${error}: ${errDesc}` : error;
        return { status: 'error', errorDetail: detail };
    },
};

async function revokeImpl(current: StoredCredential): Promise<void> {
    const token = current.refreshToken ?? current.accessToken;
    try {
        await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
            method: 'POST',
        });
    } catch (err) {
        // Best-effort — local credential deletion is the source of truth
        // for our side. Remote revoke failure shouldn't block cleanup.
        console.warn(
            `Remote revoke failed (local credential still deleted): ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
}
