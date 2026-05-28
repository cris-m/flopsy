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
import { resolveSecret } from '@flopsy/shared';

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
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube',
];

// Google's official device-flow scope allowlist
// (https://developers.google.com/identity/protocols/oauth2/limited-input-device):
//   openid, email, profile, drive.appdata, drive.file,
//   youtube, youtube.readonly
//
// Empirically verified 2026-05-12 against client `765258968732-ps76a3b...`:
//   `calendar` works in practice despite being absent from Google's published
//   allowlist — keep it but treat as fragile (Google may pull this with no notice).
//
// Definitely blocked (return invalid_scope from /device/code):
//   gmail.* (all), drive (broad), drive.readonly, drive.metadata.readonly,
//   contacts.*, tasks, photos, youtube.force-ssl
//
// Per-service device-flow whitelists in DEVICE_FLOW_SUPPORTED_SCOPES below.
const DEVICE_FLOW_SCOPES: readonly string[] = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.readonly',
];

const DEVICE_FLOW_COMMON: readonly string[] = ['openid', 'email', 'profile'];

export const DEVICE_FLOW_SUPPORTED_SCOPES: Readonly<Record<string, readonly string[]>> = {
    youtube: [
        ...DEVICE_FLOW_COMMON,
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/youtube',
    ],
    calendar: [
        ...DEVICE_FLOW_COMMON,
        'https://www.googleapis.com/auth/calendar',
    ],
};

function requireClientId(): string {
    const id = resolveSecret('GOOGLE_CLIENT_ID');
    if (!id) {
        throw new Error(
            'GOOGLE_CLIENT_ID is not set (env value missing or vault placeholder unresolved).\n' +
                '  1. Visit https://console.cloud.google.com/apis/credentials\n' +
                '  2. Create OAuth client ID → Application type: "Desktop app"\n' +
                '  3. Either: GOOGLE_CLIENT_ID=<real-value> in .env (recommended — client IDs are public per OAuth spec)\n' +
                '     Or:    flopsy vault add GOOGLE_CLIENT_ID "<value>" and use the __google_client_id__ placeholder\n' +
                '  4. Re-run `flopsy auth google`\n',
        );
    }
    return id;
}

/** Optional; Google desktop-app clients accept the secret but don't require it with PKCE. */
function optionalClientSecret(): string | undefined {
    return resolveSecret('GOOGLE_CLIENT_SECRET');
}

// Must be a "TVs and Limited Input devices" client; the Desktop client_id is rejected by /device/code.
function requireDeviceClientId(): string {
    const id = resolveSecret('GOOGLE_DEVICE_CLIENT_ID');
    if (!id) {
        throw new Error(
            'GOOGLE_DEVICE_CLIENT_ID is not set (env value missing or vault placeholder unresolved).\n' +
                '  1. Visit https://console.cloud.google.com/apis/credentials\n' +
                '  2. Create OAuth client ID → "TVs and Limited Input devices"\n' +
                '  3. Either: GOOGLE_DEVICE_CLIENT_ID=<real-value> + GOOGLE_DEVICE_CLIENT_SECRET=<real-value> in .env\n' +
                '     Or:    flopsy vault add ... and use placeholders\n' +
                '  4. Retry the in-chat connect',
        );
    }
    return id;
}

/** Google requires client_secret even for TV/Limited-Input clients (issued in the client JSON). */
function requireDeviceClientSecret(): string {
    const sec = resolveSecret('GOOGLE_DEVICE_CLIENT_SECRET');
    if (!sec) {
        throw new Error(
            'GOOGLE_DEVICE_CLIENT_SECRET is not set (env value missing or vault placeholder unresolved).\n' +
                '  Download the TV/Limited-Input OAuth client JSON from Google Cloud Console\n' +
                '  and add GOOGLE_DEVICE_CLIENT_SECRET=... to .env or vault.',
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

    async poll(
        deviceCode: string,
        scopes: readonly string[] = DEVICE_FLOW_SCOPES,
        providerName: string = 'google',
    ): Promise<DeviceFlowPoll> {
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
                provider: providerName,
                tokenType: tokens.token_type || 'Bearer',
                ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
                accessToken: tokens.access_token,
                expiresAt: now + tokens.expires_in * 1000,
                scopes: tokens.scope ? tokens.scope.split(' ') : [...scopes],
                ...(userinfo?.email ? { email: userinfo.email } : {}),
                ...(userinfo?.name ? { displayName: userinfo.name } : {}),
                meta: {
                    authMethod: 'device-flow',
                    clientIdSuffix: clientId.slice(-8),
                    ...(providerName !== 'google' ? { googleService: providerName } : {}),
                },
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

// ---------------------------------------------------------------------------
// Per-service providers.
//
// Pattern: one OAuth client (the existing Desktop client), four independent
// auth flows. Each writes to its own credential file (google-gmail.json,
// google-drive.json, google-calendar.json, google-youtube.json), each requests
// only the scopes its MCP server needs.
//
// Why: lets users connect Gmail without granting YouTube access, lets us
// re-auth one service without affecting the other three, and eliminates the
// "device flow overwrote web flow scopes" failure mode.
// ---------------------------------------------------------------------------

const COMMON_USERINFO_SCOPES: readonly string[] = ['openid', 'email', 'profile'];

const GMAIL_SCOPES: readonly string[] = [
    ...COMMON_USERINFO_SCOPES,
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
];

const DRIVE_SCOPES: readonly string[] = [
    ...COMMON_USERINFO_SCOPES,
    'https://www.googleapis.com/auth/drive',
];

const CALENDAR_SCOPES: readonly string[] = [
    ...COMMON_USERINFO_SCOPES,
    'https://www.googleapis.com/auth/calendar',
];

const YOUTUBE_SCOPES: readonly string[] = [
    ...COMMON_USERINFO_SCOPES,
    'https://www.googleapis.com/auth/youtube.readonly',
];

const CONTACTS_SCOPES: readonly string[] = [
    ...COMMON_USERINFO_SCOPES,
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/contacts.other.readonly',
];

/**
 * CLI-style device-flow runner. Loops `googleDeviceFlow.poll` until the user
 * completes the verification on another device, then saves the credential
 * to `<providerName>.json`. Throws on expiry, denial, or unrecoverable error.
 */
async function runDeviceFlowCli(
    providerName: string,
    scopes: readonly string[],
): Promise<StoredCredential> {
    const start = await googleDeviceFlow.start(scopes);

    console.log('\n  On another device, open this URL and enter the code:');
    const url = start.verificationUrlComplete ?? start.verificationUrl;
    console.log(`    ${url}`);
    if (!start.verificationUrlComplete) {
        console.log(`    Code: ${start.userCode}`);
    } else {
        console.log(`    (code ${start.userCode} pre-filled in the URL)`);
    }
    const expiresInSec = Math.max(0, Math.floor((start.expiresAt - Date.now()) / 1000));
    console.log(`\n  Waiting up to ${expiresInSec}s for authorization...`);

    let intervalMs = Math.max(1000, start.intervalSeconds * 1000);
    while (Date.now() < start.expiresAt) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const result = await googleDeviceFlow.poll(start.deviceCode, scopes, providerName);
        if (result.status === 'success') return result.credential;
        if (result.status === 'pending') {
            if (result.slowDown) intervalMs += 5000;
            continue;
        }
        if (result.status === 'expired') {
            throw new Error('Device flow expired before authorization. Re-run the command.');
        }
        if (result.status === 'denied') {
            throw new Error('Authorization denied by the user.');
        }
        throw new Error(`Device flow failed: ${result.errorDetail}`);
    }
    throw new Error('Device flow timed out before authorization completed.');
}

/**
 * Factory for per-service Google OAuth providers. Each gets its own credential
 * file via the `name` field (which credential-store uses as the file basename).
 *
 * Default flow is WEB (browser callback). When `opts.useDeviceFlow` is set,
 * falls back to RFC 8628 device flow IF the service has scopes on Google's
 * device-flow allowlist (see DEVICE_FLOW_SUPPORTED_SCOPES). Services that
 * Google blocks (gmail, contacts, full drive) throw a clear error.
 */
function makeGoogleServiceProvider(
    name: string,
    displayName: string,
    serviceScopes: readonly string[],
): AuthProvider {
    return {
        name,
        displayName,
        defaultScopes: serviceScopes,

        async authorize(opts: AuthorizeOptions = {}): Promise<StoredCredential> {
            if (opts.useDeviceFlow) {
                const deviceScopes = DEVICE_FLOW_SUPPORTED_SCOPES[name];
                if (!deviceScopes) {
                    const supported = Object.keys(DEVICE_FLOW_SUPPORTED_SCOPES).join(', ');
                    throw new Error(
                        `Device flow is not supported for "${name}" — Google's allowlist ` +
                            `excludes its scopes.\n` +
                            `Device-flow-capable services: ${supported}.\n` +
                            `Use the default web flow instead: flopsy auth ${name}`,
                    );
                }
                return runDeviceFlowCli(name, deviceScopes);
            }

            const clientId = requireClientId();
            const clientSecret = optionalClientSecret();
            const scopes = opts.scopes?.length
                ? [...new Set([...serviceScopes, ...opts.scopes])]
                : serviceScopes;

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
            authorizeUrl.searchParams.set('access_type', 'offline');
            authorizeUrl.searchParams.set('prompt', 'consent');

            const authorizeUrlStr = authorizeUrl.toString();
            console.log(`\nOpen the following URL to authorize ${displayName}:\n\n  ${authorizeUrlStr}\n`);
            if (!opts.noOpen) openInBrowser(authorizeUrlStr);
            console.log('Waiting for callback...');

            const cb: CallbackResult = await result;
            if (cb.state !== state) {
                throw new Error('OAuth state mismatch — aborting (stale browser tab?).');
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
                provider: name,
                tokenType: tokens.token_type || 'Bearer',
                accessToken: tokens.access_token,
                ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
                expiresAt: now + tokens.expires_in * 1000,
                scopes: tokens.scope ? tokens.scope.split(' ') : [...scopes],
                ...(userinfo?.email ? { email: userinfo.email } : {}),
                ...(userinfo?.name ? { displayName: userinfo.name } : {}),
                meta: {
                    clientIdSuffix: clientId.slice(-8),
                    googleService: name,
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
                    `Credential has no refresh_token. Re-run \`flopsy auth ${name.replace(/^google-/, '')}\` to reauthorize.`,
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
                refreshToken: tokens.refresh_token ?? current.refreshToken,
                expiresAt: now + tokens.expires_in * 1000,
                scopes: tokens.scope ? tokens.scope.split(' ') : current.scopes,
            };
            saveCredential(refreshed);
            return refreshed;
        },

        async revoke(current: StoredCredential): Promise<void> {
            await revokeImpl(current);
        },
    };
}

export const gmailProvider = makeGoogleServiceProvider(
    'gmail',
    'Gmail (read, send, modify)',
    GMAIL_SCOPES,
);

export const driveProvider = makeGoogleServiceProvider(
    'drive',
    'Google Drive (full read/write/share/trash)',
    DRIVE_SCOPES,
);

export const calendarProvider = makeGoogleServiceProvider(
    'calendar',
    'Google Calendar (events read/write)',
    CALENDAR_SCOPES,
);

export const youtubeProvider = makeGoogleServiceProvider(
    'youtube',
    'YouTube (read-only — search, playlists, subscriptions)',
    YOUTUBE_SCOPES,
);

export const contactsProvider = makeGoogleServiceProvider(
    'contacts',
    'Google Contacts (read-only — name/email/phone lookup)',
    CONTACTS_SCOPES,
);
