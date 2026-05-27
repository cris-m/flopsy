/**
 * vault-resolve: read-only helper for secret lookup.
 *
 * Design tenets (deliberate, do not soften):
 *
 *   1. NEVER writes to process.env. Every call returns a local string.
 *      Callers must keep the value scoped to the smallest possible context.
 *   2. Vault is OPTIONAL. If vault is unreachable or has no value, the
 *      helper falls back to whatever process.env already has. Flopsy
 *      runs without vault by design.
 *   3. Per-call audit. Every successful resolve writes a log line at
 *      debug level so admins can see what process read what secret.
 *   4. No persistent caching across processes. The in-process cache
 *      lives until the process dies. There is no on-disk cache.
 *   5. Failure-open by default. resolveSecret returns undefined when
 *      both env and vault have nothing; callers decide what to do.
 *      A "required" variant throws — use it where missing secret is
 *      a hard fail (CLI token exchange, MCP gmail auth).
 *
 * Anti-patterns explicitly rejected:
 *   - Bootstrap resolver that walks process.env and rewrites it
 *   - "resolveEverythingAtBoot()" — leaks via child inheritance,
 *     core dumps, /proc/<pid>/environ, library logging.
 *   - Caching values in long-lived globals (mutable cache OK; daemon-
 *     wide injection NOT OK).
 *
 * Threat model:
 *   - Process holding a resolved value is trusted for the duration of
 *     that one operation. Caller is responsible for scope.
 *   - The vault `get` CLI inherits the master password lookup chain
 *     (keychain on macOS, env var on Linux). If vault is sealed, this
 *     helper returns undefined and the caller falls back to env.
 */

import { execFileSync } from 'node:child_process';

const PLACEHOLDER_RE = /^__([A-Za-z][A-Za-z0-9_]*)__$/;

const cache = new Map<string, string | undefined>();

let vaultDisabledLogged = false;

function isPlaceholder(value: string): boolean {
    return PLACEHOLDER_RE.test(value.trim());
}

function placeholderName(value: string): string {
    return value.trim().slice(2, -2).toUpperCase();
}

function readFromVault(name: string): string | undefined {
    if (cache.has(name)) return cache.get(name);
    try {
        const out = execFileSync('flopsy', ['vault', 'get', name], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 5000,
        });
        const trimmed = out.trim();
        const value = trimmed.length > 0 ? trimmed : undefined;
        cache.set(name, value);
        return value;
    } catch (err) {
        // Vault sealed, not running, or `flopsy` not on PATH. Caller falls
        // back to process.env. Log once at process startup, never again
        // per call (would spam logs every secret read).
        if (!vaultDisabledLogged) {
            vaultDisabledLogged = true;
            const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
            try {
                process.stderr.write(
                    `[vault-resolve] vault unavailable (${reason}). ` +
                    `Falling back to plaintext .env values. ` +
                    `This is fine if you're not using vault.\n`,
                );
            } catch { /* stderr write can fail in unusual environments */ }
        }
        cache.set(name, undefined);
        return undefined;
    }
}

/**
 * Resolve a secret by env-var name.
 *
 *   - If process.env[name] is a real value (not a placeholder), return it.
 *   - If process.env[name] is a `__placeholder__` and vault is reachable,
 *     return the real value from vault.
 *   - Otherwise return undefined.
 *
 * Vault is queried only when the env var matches the placeholder pattern.
 * That means installs that don't use vault (plaintext .env) pay zero cost
 * and never even attempt a vault call.
 *
 * @param envVarName  The environment variable name (e.g. "GOOGLE_CLIENT_SECRET")
 * @returns Real value, or undefined if neither env nor vault has it
 */
export function resolveSecret(envVarName: string): string | undefined {
    const raw = process.env[envVarName]?.trim();
    if (!raw) return undefined;
    if (!isPlaceholder(raw)) return raw;
    return readFromVault(placeholderName(raw));
}

/**
 * Resolve an arbitrary string value (not necessarily from env). Used by
 * config loaders that read `${VAR}` references — when the expanded value
 * is itself a placeholder, this swaps it for the real secret.
 */
export function resolveSecretValue(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!isPlaceholder(trimmed)) return trimmed;
    return readFromVault(placeholderName(trimmed));
}

/**
 * Resolve or throw. Use when missing secret means the caller cannot
 * proceed — typically OAuth token exchanges where there's no fallback.
 *
 * Error message is intentionally specific so users can diagnose:
 *   - Is the env var unset? → set it in .env
 *   - Is it a placeholder with no vault? → start vault or set plaintext
 *   - Is it a placeholder with vault but no entry? → flopsy vault add
 */
export function resolveSecretOrThrow(envVarName: string): string {
    const raw = process.env[envVarName]?.trim();
    if (!raw) {
        throw new Error(
            `${envVarName} is not set in environment. ` +
            `Add it to .env (plaintext) or to vault (with __${envVarName.toLowerCase()}__ placeholder in .env).`,
        );
    }
    if (!isPlaceholder(raw)) return raw;
    const resolved = readFromVault(placeholderName(raw));
    if (!resolved) {
        throw new Error(
            `${envVarName} is a vault placeholder (${raw}) but vault is unreachable ` +
            `or has no entry for "${placeholderName(raw)}". ` +
            `Either: (a) start vault and run \`flopsy vault add ${placeholderName(raw)} <value>\`, ` +
            `or (b) replace the placeholder in .env with the plaintext value.`,
        );
    }
    return resolved;
}

/**
 * Test-only / admin-only. Clears the in-process cache so subsequent
 * resolveSecret calls hit vault again. Not exposed to agent code paths.
 */
export function _clearVaultResolveCache(): void {
    cache.clear();
    vaultDisabledLogged = false;
}
