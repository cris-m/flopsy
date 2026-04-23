/**
 * Credential storage shape — one file per provider under
 * `<FLOPSY_HOME>/auth/<provider>.json` with chmod 600. Intentionally
 * schemaless beyond the core fields so providers can stash extras
 * (project ids, tenant, etc.) in `meta` without migrating the
 * storage layer.
 */
export interface StoredCredential {
    /** Provider name — matches the registry key (e.g. 'google'). */
    readonly provider: string;
    /** OAuth token type. Nearly always 'Bearer' for modern providers. */
    readonly tokenType: 'Bearer' | 'bearer' | string;
    readonly accessToken: string;
    /** Optional — some providers don't issue refresh tokens (short-lived sessions). */
    readonly refreshToken?: string;
    /** Unix ms epoch when `accessToken` stops being valid. */
    readonly expiresAt: number;
    readonly scopes: readonly string[];

    // Identity (best-effort — for `flopsy auth status` display)
    readonly email?: string;
    readonly displayName?: string;

    /** Provider-specific blob. Never interpret outside the provider module. */
    readonly meta?: Record<string, unknown>;

    /** Unix ms epoch of initial authorization — never overwritten on refresh. */
    readonly authorizedAt: number;
}

export interface AuthorizeOptions {
    /** Extra scopes beyond the provider's defaults. */
    readonly scopes?: readonly string[];
    /** Override the callback port (default: OS-assigned). */
    readonly callbackPort?: number;
    /** Suppress the automatic browser-open (print URL for copy/paste). */
    readonly noOpen?: boolean;
}

/**
 * Every provider implements this. Must be pure in the sense that calling
 * `authorize()` twice always goes through the OAuth flow again (no
 * caching) — caching lives in the credential store.
 */
export interface AuthProvider {
    readonly name: string;
    readonly displayName: string;
    readonly defaultScopes: readonly string[];

    /** Returns a fresh credential. Writes it to the store as a side effect. */
    authorize(opts?: AuthorizeOptions): Promise<StoredCredential>;

    /**
     * Exchange a refresh_token for a new access_token. Implementations
     * must preserve `refreshToken` if the response omits one (common
     * server behaviour) and update `accessToken` + `expiresAt`.
     */
    refresh(current: StoredCredential): Promise<StoredCredential>;

    /**
     * Best-effort remote revoke. Local credential deletion is handled by
     * the CLI regardless of whether this succeeds.
     */
    revoke?(current: StoredCredential): Promise<void>;
}
