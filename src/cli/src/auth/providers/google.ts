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
// Device flow (RFC 8628) — uses Google's "TV/Limited Input" OAuth client type.
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const DEVICE_VERIFICATION_URL = 'https://www.google.com/device';

// Google rejects with `invalid_scope` if any of these aren't on the consent screen.
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

// Every scope here MUST be on Google's device-flow allowlist AND on the consent screen.
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

// Must be a "TVs and Limited Input devices" client; the Desktop client_id is rejected by /device/code.
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
    /** True for RFC 8628 §3.5 `slow_down` — caller MUST add 5s to its current interval, not overwrite. */
    readonly slowDown?: boolean;
}
export interface DeviceFlowPollExpired {
    readonly status: 'expired';
}
export interface DeviceFlowPollDenied {
    readonly status: 'denied';
}
/** Non-terminal OAuth error (invalid_grant/client/scope) — distinct from `denied`. */
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
        // access_type=offline → refresh_token; without it Google issues only a 1h access_token.
        authorizeUrl.searchParams.set('access_type', 'offline');
        // prompt=consent forces re-display so scope changes on re-auth aren't silently dropped.
        authorizeUrl.searchParams.set('prompt', 'consent');

        const authorizeUrlStr = authorizeUrl.toString();

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
        await revokeImpl(current);
    },
};

export const googleDeviceFlow = {
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
            // RFC 8628 §3.5: caller MUST add 5s to its running interval (we don't track it here).
            return { status: 'pending', intervalSeconds: 5, slowDown: true };
        }
        if (error === 'expired_token') return { status: 'expired' };
        if (error === 'access_denied') return { status: 'denied' };

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
        // Best-effort — local credential deletion is what guarantees cleanup on our side.
        console.warn(
            `Remote revoke failed (local credential still deleted): ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
}
