/**
 * Resolve the management API token.
 *
 * Precedence: `GATEWAY_TOKEN` env → `<FLOPSY_HOME>/gateway-token` file →
 * generate fresh 32-byte hex token + persist (gateway side only).
 *
 * IMPORTANT: keep GATEWAY_TOKEN a REAL value in .env — do NOT vault it to a
 * `__placeholder__`. The gateway can hydrate a placeholder from the vault, but
 * the CLI cannot, so a placeholder makes the CLI send the wrong token → 401.
 * GATEWAY_TOKEN is a control-plane token; plaintext in .env is the right place.
 *
 * The file is 0600 (owner-only); both gateway and CLI share it under FLOPSY_HOME
 * when GATEWAY_TOKEN is unset.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveFlopsyHome } from './workspace';

const TOKEN_FILENAME = 'gateway-token';
const TOKEN_BYTES = 32;

function tokenPath(): string {
    return join(resolveFlopsyHome(), TOKEN_FILENAME);
}

/** CLI side: read-only. Returns null when neither env nor file is present. */
export function loadMgmtToken(): string | null {
    const envToken = process.env['GATEWAY_TOKEN'];
    if (envToken && envToken.trim().length > 0) return envToken.trim();
    const path = tokenPath();
    if (!existsSync(path)) return null;
    try {
        const raw = readFileSync(path, 'utf8').trim();
        return raw.length > 0 ? raw : null;
    } catch {
        // Stale file → skip auth header, request fails at the server with 401.
        return null;
    }
}

/** Gateway side: env → file → mint+persist (0600). Idempotent across boots. */
export function resolveOrCreateMgmtToken(): string {
    const envToken = process.env['GATEWAY_TOKEN'];
    if (envToken && envToken.trim().length > 0) return envToken.trim();

    const path = tokenPath();
    if (existsSync(path)) {
        try {
            const raw = readFileSync(path, 'utf8').trim();
            if (raw.length > 0) return raw;
        } catch {
            /* fall through and regenerate */
        }
    }

    const token = randomBytes(TOKEN_BYTES).toString('hex');
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, token + '\n', { mode: 0o600 });
        // chmod explicitly — writeFileSync's `mode` honors umask, which can drop to 0644.
        chmodSync(path, 0o600);
    } catch {
        // Persist failure isn't fatal; token still works this boot.
    }
    return token;
}
