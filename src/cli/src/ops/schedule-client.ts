/**
 * Shared management-HTTP client for every CLI command that talks to the running
 * gateway (`flopsy heartbeat`, `cron`, `webhook`, `dnd`, `management`, `tasks`).
 * Centralises URL resolution, bearer-token handling, response shaping,
 * and the offline SQLite fallback used by schedule list/show.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { loadMgmtToken, resolveWorkspacePath } from '@flopsy/shared';
import { bad, info, ok, row } from '../ui/pretty';
import { readFlopsyConfig } from './config-reader';

export type ScheduleKind = 'heartbeat' | 'cron' | 'webhook';

export interface RuntimeScheduleRow {
    id: string;
    kind: ScheduleKind;
    configJson: string;
    enabled: boolean;
    createdAt: number;
    createdByThread: string | null;
    createdByAgent: string | null;
}

/** Open proactive.db read-only. Returns null when the file doesn't exist
 * yet (gateway never ran with proactive enabled). */
export function openProactiveDbReadonly(): Database.Database | null {
    const path = resolveWorkspacePath('state', 'proactive.db');
    if (!existsSync(path)) return null;
    const db = new Database(path, { readonly: true });
    db.pragma('busy_timeout = 2000');
    return db;
}

/** Fetch all runtime schedules of a given kind directly from SQLite. No
 * HTTP round-trip — works even when the gateway is stopped. */
export function loadSchedulesOfKind(kind: ScheduleKind): RuntimeScheduleRow[] | null {
    const db = openProactiveDbReadonly();
    if (!db) return null;
    try {
        const stmt = db.prepare(
            `SELECT id, kind, config_json, enabled, created_at, created_by_thread, created_by_agent
             FROM proactive_runtime_schedules
             WHERE kind = ?
             ORDER BY created_at DESC`,
        );
        const rows = stmt.all(kind) as Array<{
            id: string;
            kind: string;
            config_json: string;
            enabled: number;
            created_at: number;
            created_by_thread: string | null;
            created_by_agent: string | null;
        }>;
        return rows.map((r) => ({
            id: r.id,
            kind: r.kind as ScheduleKind,
            configJson: r.config_json,
            enabled: r.enabled === 1,
            createdAt: r.created_at,
            createdByThread: r.created_by_thread,
            createdByAgent: r.created_by_agent,
        }));
    } finally {
        db.close();
    }
}

export function parseConfig(row: RuntimeScheduleRow): Record<string, unknown> {
    try {
        return JSON.parse(row.configJson) as Record<string, unknown>;
    } catch {
        return {};
    }
}

/** Resolve a management endpoint URL from flopsy.json5, with a sane fallback. */
export function managementUrl(path: string): string {
    try {
        const { config } = readFlopsyConfig();
        const gw = config.gateway ?? {};
        // Explicit gateway.management.port wins. Without it, fall back to
        // gateway.port + 2 instead of +1 — the +1 default collides with
        // webhook.port (also default 18790), routing every CLI command
        // to the webhook server and producing "Missing signature" errors.
        // +2 (= 18791) leaves room for the webhook server at +1.
        const port =
            (gw as { management?: { port?: number } }).management?.port ?? ((gw.port ?? 18789) + 2);
        const host = (gw as { management?: { host?: string } }).management?.host ?? '127.0.0.1';
        return `http://${host}:${port}${path}`;
    } catch {
        return `http://127.0.0.1:18791${path}`;
    }
}

function authHeaders(): Record<string, string> {
    // Read from env first, then from the gateway-generated <HOME>/mgmt-token
    // file. The CLI is a separate process from the gateway so env-var
    // inheritance can't be assumed; the file is the steady-state path on
    // fresh installs where the operator never sets FLOPSY_MGMT_TOKEN.
    const token = loadMgmtToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Write-style management call: expects 2xx JSON, prints ok/error, exits on failure. */
export async function managementFetch(
    method: string,
    path: string,
    body?: unknown,
): Promise<void> {
    const url = managementUrl(path);
    try {
        const res = await fetch(url, {
            method,
            headers: { 'content-type': 'application/json', ...authHeaders() },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(5000),
        });
        const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
            const msg =
                (parsed['error'] as string) ??
                (parsed['message'] as string) ??
                `HTTP ${res.status}`;
            console.log(bad(msg));
            process.exit(1);
        }
        const msg = (parsed['message'] as string) ?? `${method} ${path} → ${res.status}`;
        console.log(ok(msg));
        if (parsed['id']) console.log(row('id', String(parsed['id'])));
    } catch (err) {
        unreachable(url, err);
    }
}

export const managementCreate = (body: Record<string, unknown>): Promise<void> =>
    managementFetch('POST', '/management/schedule', body);
export const managementRemove = (id: string): Promise<void> =>
    managementFetch('DELETE', `/management/schedule/${encodeURIComponent(id)}`);
export const managementEnable = (id: string): Promise<void> =>
    managementFetch('POST', `/management/schedule/${encodeURIComponent(id)}/enable`);
export const managementDisable = (id: string): Promise<void> =>
    managementFetch('POST', `/management/schedule/${encodeURIComponent(id)}/disable`);
export const managementTrigger = (id: string): Promise<void> =>
    managementFetch('POST', `/management/schedule/${encodeURIComponent(id)}/trigger`);
export const managementSetSkills = (id: string, skills: string[]): Promise<void> =>
    managementFetch('POST', `/management/schedule/${encodeURIComponent(id)}/skills`, {
        skills,
    });
export const managementTick = (kind: 'cron' | 'heartbeat'): Promise<void> =>
    managementFetch('POST', `/management/schedule/tick?kind=${kind}`);

/** Read-style management call: returns parsed JSON or null on error (prints once). */
export async function managementFetchJson<T>(
    method: string,
    path: string,
    body?: unknown,
): Promise<T | null> {
    const url = managementUrl(path);
    try {
        const res = await fetch(url, {
            method,
            headers: { 'content-type': 'application/json', ...authHeaders() },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
            console.log(
                bad(
                    (parsed['error'] as string) ??
                        (parsed['message'] as string) ??
                        `HTTP ${res.status}`,
                ),
            );
            return null;
        }
        return (await res.json()) as T;
    } catch (err) {
        unreachableSoft(url, err);
        return null;
    }
}

function unreachable(url: string, err: unknown): never {
    unreachableSoft(url, err);
    process.exit(1);
}

function unreachableSoft(url: string, err: unknown): void {
    const hint = err instanceof Error ? err.message : String(err);
    console.log(bad(`management endpoint unreachable at ${url}`));
    console.log(
        info(`gateway not running? start with \`flopsy gateway start\`. hint: ${hint}`),
    );
}

export interface ProactiveStats {
    window: { sinceMs: number; windowMs: number };
    aggregate: { delivered: number; retryQueueDepth: number };
    perSchedule: Array<{
        id: string;
        kind: ScheduleKind;
        enabled: boolean;
        name: string;
        runCount: number;
        deliveredCount: number;
        suppressedCount: number;
        queuedCount: number;
        consecutiveErrors: number;
        lastRunAt?: number;
        lastStatus?: 'success' | 'error';
        lastAction?: string;
        lastError?: string;
        deliveredInWindow: number;
    }>;
}

export interface FireRow {
    deliveredAt: number;
    content: string;
}

/** GET /management/proactive/stats — whole-engine aggregate + per-schedule. */
export async function fetchProactiveStats(windowMs = 86_400_000): Promise<ProactiveStats | null> {
    return managementFetchJson<ProactiveStats>(
        'GET',
        `/management/proactive/stats?windowMs=${windowMs}`,
    );
}

/** GET /management/proactive/fires/:id — delivery history for one schedule. */
export async function fetchFires(id: string, limit = 20): Promise<FireRow[]> {
    const body = await managementFetchJson<{ fires: FireRow[] }>(
        'GET',
        `/management/proactive/fires/${encodeURIComponent(id)}?limit=${limit}`,
    );
    return body?.fires ?? [];
}
