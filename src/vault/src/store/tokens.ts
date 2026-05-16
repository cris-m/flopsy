import type { Database as Db } from 'better-sqlite3';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_PREFIX = 'fv_agt_';

export interface TokenRow {
    label: string;
    scope: string;
    expiresAt: number | null;
    revoked: boolean;
    createdAt: number;
}

export interface MintTokenInput {
    label: string;
    allowHosts?: string[];
    allowSecrets?: string[];
    ttlMs?: number;
}

export interface MintTokenResult {
    rawToken: string;
    label: string;
    expiresAt: number | null;
}

function hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

function encodeScope(input: MintTokenInput): string {
    return JSON.stringify({
        allowHosts: input.allowHosts ?? [],
        allowSecrets: input.allowSecrets ?? [],
    });
}

export interface DecodedScope {
    allowHosts: string[];
    allowSecrets: string[];
}

export function decodeScope(scope: string): DecodedScope {
    try {
        const parsed = JSON.parse(scope) as Partial<DecodedScope>;
        return {
            allowHosts: Array.isArray(parsed.allowHosts) ? parsed.allowHosts : [],
            allowSecrets: Array.isArray(parsed.allowSecrets) ? parsed.allowSecrets : [],
        };
    } catch {
        return { allowHosts: [], allowSecrets: [] };
    }
}

export function mintToken(db: Db, input: MintTokenInput): MintTokenResult {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.label)) {
        throw new Error('label must be 1–64 chars of [A-Za-z0-9._-]');
    }
    const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const hash = hashToken(raw);
    const now = Date.now();
    const expiresAt = input.ttlMs && input.ttlMs > 0 ? now + input.ttlMs : null;
    db.prepare(
        `INSERT INTO vault_tokens(token_hash, label, scope, expires_at, revoked, created_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(token_hash) DO NOTHING`,
    ).run(hash, input.label, encodeScope(input), expiresAt, now);
    return { rawToken: raw, label: input.label, expiresAt };
}

export interface VerifiedToken {
    label: string;
    scope: DecodedScope;
    expiresAt: number | null;
}

export class TokenVerifyError extends Error {
    constructor(public reason: 'invalid' | 'expired' | 'revoked' | 'malformed') {
        super(`token verify failed: ${reason}`);
        this.name = 'TokenVerifyError';
    }
}

export function verifyToken(db: Db, raw: string): VerifiedToken {
    if (typeof raw !== 'string' || !raw.startsWith(TOKEN_PREFIX) || raw.length < TOKEN_PREFIX.length + 32) {
        throw new TokenVerifyError('malformed');
    }
    const hash = hashToken(raw);
    const row = db
        .prepare(
            'SELECT label, scope, expires_at as expiresAt, revoked, token_hash as tokenHash FROM vault_tokens WHERE token_hash = ?',
        )
        .get(hash) as { label: string; scope: string; expiresAt: number | null; revoked: number; tokenHash: string } | undefined;
    if (!row) throw new TokenVerifyError('invalid');
    const expectedHash = Buffer.from(row.tokenHash, 'hex');
    const actualHash = Buffer.from(hash, 'hex');
    if (expectedHash.length !== actualHash.length || !timingSafeEqual(expectedHash, actualHash)) {
        throw new TokenVerifyError('invalid');
    }
    if (row.revoked) throw new TokenVerifyError('revoked');
    if (row.expiresAt !== null && row.expiresAt < Date.now()) throw new TokenVerifyError('expired');
    return { label: row.label, scope: decodeScope(row.scope), expiresAt: row.expiresAt };
}

export function listTokens(db: Db): TokenRow[] {
    return db
        .prepare(
            `SELECT label, scope, expires_at as expiresAt,
                    CASE revoked WHEN 1 THEN 1 ELSE 0 END as revoked,
                    created_at as createdAt
             FROM vault_tokens
             ORDER BY created_at DESC`,
        )
        .all() as TokenRow[];
}

export function revokeToken(db: Db, label: string): boolean {
    const info = db.prepare('UPDATE vault_tokens SET revoked = 1 WHERE label = ? AND revoked = 0').run(label);
    return info.changes > 0;
}

export function deleteToken(db: Db, label: string): boolean {
    const info = db.prepare('DELETE FROM vault_tokens WHERE label = ?').run(label);
    return info.changes > 0;
}

export function hostMatchesScope(scope: DecodedScope, host: string): boolean {
    if (scope.allowHosts.length === 0) return false;
    return scope.allowHosts.some((pattern) => matchesPattern(host, pattern));
}

export function secretMatchesScope(scope: DecodedScope, name: string): boolean {
    if (scope.allowSecrets.length === 0) return false;
    return scope.allowSecrets.some((pattern) => matchesPattern(name, pattern));
}

function matchesPattern(value: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1);
        return value.endsWith(suffix);
    }
    return value === pattern;
}
