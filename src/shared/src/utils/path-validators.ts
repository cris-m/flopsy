/**
 * Path validators for user-supplied paths that flow into the proactive
 * engine's filesystem operations.
 *
 * Used by both the management HTTP API (`handleMgmtScheduleCreate`) and
 * the LLM-driven `manage_schedule` agent tool. Previously the mgmt API
 * had validators but the agent tool called `copyPromptFile` directly with
 * `args.promptFile.startsWith('/')` and no further checks — an
 * LLM-injection vector that could ingest /etc/passwd into the workspace.
 *
 * These validators are deliberately conservative: they reject anything
 * that looks like an attempt to escape the intended directory, even if
 * the path would resolve fine. Single-operator threat model still applies
 * (the daemon's UID can read whatever the operator can), but defense in
 * depth here closes the prompt-injection attack surface.
 */

import { resolve as resolvePath } from 'node:path';

/** Filesystem locations no operator should ever legitimately copy from
 *  as a "prompt file." `/var/log` and `/var/lib` are included because
 *  they hold sensitive secrets on typical Linux installs. */
const BLOCKED_PROMPT_PREFIXES = [
    '/etc/',
    '/proc/',
    '/sys/',
    '/dev/',
    '/var/log/',
    '/var/lib/',
];

/**
 * Validate a user-supplied `promptFile` path before passing it to
 * `copyPromptFile`. Returns the (normalized) path on success, or a string
 * error message on rejection.
 *
 * The validator passes absolute paths (the CLI legitimately authors
 * --prompt-file from anywhere on the operator's disk), but rejects:
 *   - non-string / empty input
 *   - paths containing null bytes
 *   - paths inside well-known system directories
 *
 * Caller is responsible for: (a) calling `resolvePath` again on the
 * returned path if they want to be paranoid about TOCTOU; (b) handling
 * `copyPromptFile` errors (ENOENT, EACCES).
 */
export function validateExternalPromptFile(
    raw: unknown,
): { ok: true; path: string } | { ok: false; error: string } {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { ok: false, error: 'promptFile must be a non-empty string' };
    }
    if (raw.includes('\0')) {
        return { ok: false, error: 'promptFile contains null byte' };
    }
    const path = resolvePath(raw);
    for (const prefix of BLOCKED_PROMPT_PREFIXES) {
        if (path === prefix.slice(0, -1) || path.startsWith(prefix)) {
            return { ok: false, error: `promptFile rejected: refusing to read from ${prefix}` };
        }
    }
    return { ok: true, path };
}

/**
 * Validate a user-supplied `script` / `preCheckScript` path before
 * persisting it on a schedule. The downstream script runner jails
 * execution to `<FLOPSY_HOME>/scripts/`, but defense-in-depth: reject
 * `..` segments, absolute paths, and null bytes here so misuse fails
 * fast with a clear error.
 *
 * Returns `{ ok: true, path: undefined }` for null/undefined/empty
 * inputs so callers can pass-through `body[fieldName]` without
 * pre-checking.
 */
export function validateScriptPath(
    raw: unknown,
    fieldName: string,
): { ok: true; path: string | undefined } | { ok: false; error: string } {
    if (raw === undefined || raw === null) return { ok: true, path: undefined };
    if (typeof raw !== 'string') {
        return { ok: false, error: `${fieldName} must be a string` };
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: true, path: undefined };
    if (trimmed.includes('\0')) {
        return { ok: false, error: `${fieldName} contains null byte` };
    }
    if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
        return { ok: false, error: `${fieldName} must be a relative path under <FLOPSY_HOME>/scripts/` };
    }
    const segments = trimmed.split(/[/\\]/);
    if (segments.some((s) => s === '..' || s === '.' || s.length === 0)) {
        return { ok: false, error: `${fieldName} must not contain '..' or '.' segments` };
    }
    return { ok: true, path: trimmed };
}

/**
 * Validate an identifier that becomes part of a filesystem path — schedule
 * ids, skill names, etc. Constructed paths like `${id}-<basename>` allow
 * `..` escape via `id = '../../tmp'`, so we constrain identifiers to a
 * filesystem-safe character class.
 *
 * Mirrors the SAFE_NAME pattern in the gateway's slash-command skill
 * handler. Lowercased on purpose so the same id round-trips through
 * case-insensitive filesystems (macOS) the same way it does on Linux.
 */
const SAFE_IDENTIFIER_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

export function validatePathIdentifier(
    raw: unknown,
    fieldName: string,
): { ok: true; value: string } | { ok: false; error: string } {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { ok: false, error: `${fieldName} must be a non-empty string` };
    }
    const trimmed = raw.trim();
    if (!SAFE_IDENTIFIER_RE.test(trimmed)) {
        return {
            ok: false,
            error: `${fieldName} must match ${SAFE_IDENTIFIER_RE.source} (no slashes, dots, or special chars)`,
        };
    }
    return { ok: true, value: trimmed };
}
