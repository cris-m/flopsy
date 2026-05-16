import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

export type InjectInto =
    | { kind: 'header'; name: string }
    | { kind: 'body' }
    | { kind: 'query'; name: string };

export interface RuleRow {
    id: string;
    hostPattern: string;
    placeholder: string;
    secretName: string;
    injectInto: string;
    createdAt: number;
}

export interface AddRuleInput {
    hostPattern: string;
    placeholder: string;
    secretName: string;
    injectInto: string;
}

export function addRule(db: Db, input: AddRuleInput): string {
    if (!/^[A-Za-z0-9.*-]{1,253}$/.test(input.hostPattern)) {
        throw new Error('hostPattern must be a hostname (dots, dashes, *, alnum)');
    }
    if (input.placeholder.length < 4) {
        throw new Error('placeholder too short (use something like __anthropic_api_key__)');
    }
    if (!parseInjectInto(input.injectInto)) {
        throw new Error('injectInto must be "header:<name>" | "body" | "query:<name>"');
    }
    const id = randomBytes(8).toString('hex');
    db.prepare(
        `INSERT INTO vault_rules(id, host_pattern, placeholder, secret_name, inject_into, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.hostPattern, input.placeholder, input.secretName, input.injectInto, Date.now());
    return id;
}

export function listRules(db: Db): RuleRow[] {
    return db
        .prepare(
            `SELECT id, host_pattern as hostPattern, placeholder, secret_name as secretName,
                    inject_into as injectInto, created_at as createdAt
             FROM vault_rules ORDER BY host_pattern`,
        )
        .all() as RuleRow[];
}

export function removeRule(db: Db, id: string): boolean {
    const info = db.prepare('DELETE FROM vault_rules WHERE id = ?').run(id);
    return info.changes > 0;
}

export function matchRule(db: Db, host: string): RuleRow[] {
    const all = listRules(db);
    return all.filter((r) => hostMatches(host, r.hostPattern));
}

export function hostMatches(host: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern === host) return true;
    if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1);
        return host.endsWith(suffix);
    }
    return false;
}

export function parseInjectInto(s: string): InjectInto | undefined {
    if (s === 'body') return { kind: 'body' };
    const headerMatch = s.match(/^header:(.+)$/);
    if (headerMatch) return { kind: 'header', name: headerMatch[1]!.trim() };
    const queryMatch = s.match(/^query:(.+)$/);
    if (queryMatch) return { kind: 'query', name: queryMatch[1]!.trim() };
    return undefined;
}
