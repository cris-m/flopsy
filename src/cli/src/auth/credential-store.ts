/**
 * Credential store — one JSON file per provider under
 * `<FLOPSY_HOME>/auth/<provider>.json`. File perms set to 0600 so only
 * the owning user can read.
 *
 * Plain JSON (not encrypted) is the right trade-off for local-only
 * single-user CLI today. When we go multi-user or network-exposed,
 * upgrade to the OS keychain (keytar) — swap this module, keep the
 * signatures.
 */

import {
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveFlopsyHome } from '@flopsy/shared';
import type { StoredCredential } from './types';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function authDir(): string {
    return join(resolveFlopsyHome(), 'auth');
}

function credentialPath(provider: string): string {
    if (!/^[a-z][a-z0-9-]*$/.test(provider)) {
        throw new Error(
            `Invalid provider name "${provider}": must match /^[a-z][a-z0-9-]*$/`,
        );
    }
    return join(authDir(), `${provider}.json`);
}

function ensureAuthDir(): void {
    const dir = authDir();
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    }
}

export function saveCredential(cred: StoredCredential): void {
    ensureAuthDir();
    const path = credentialPath(cred.provider);
    const tmp = `${path}.tmp`;
    // Atomic write: write to tmp, chmod, rename. Prevents a crash mid-write
    // from leaving a truncated token file.
    writeFileSync(tmp, JSON.stringify(cred, null, 2));
    try {
        chmodSync(tmp, FILE_MODE);
    } catch {
        /* best-effort on filesystems that don't support chmod */
    }
    renameSync(tmp, path);
}

export function loadCredential(provider: string): StoredCredential | null {
    const path = credentialPath(provider);
    if (!existsSync(path)) return null;
    try {
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw) as StoredCredential;
        if (parsed.provider !== provider) {
            throw new Error(
                `Credential file at ${path} claims provider "${parsed.provider}" — refusing to load.`,
            );
        }
        return parsed;
    } catch (err) {
        throw new Error(
            `Failed to read credential for "${provider}" at ${path}: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
}

export function deleteCredential(provider: string): boolean {
    const path = credentialPath(provider);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
}

/**
 * List all provider names that have a stored credential. Surfaces the
 * `flopsy auth status` view without reading every file.
 */
export function listCredentialProviders(): string[] {
    const dir = authDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name: string) => name.endsWith('.json'))
        .map((name: string) => name.replace(/\.json$/, ''))
        .sort();
}
