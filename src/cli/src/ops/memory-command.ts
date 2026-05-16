/**
 * `flopsy memory kpi` — per-namespace memory stats from the SQLite store.
 *
 * Reads `.flopsy/state/memory.db` directly (no gateway required).
 * Each row in the output is one namespace — typically `memories` (shared
 * user prefs saved by gandalf) or `memories:<agent>` (per-worker).
 *
 * Output columns:
 *   namespace  count  newest  oldest
 *
 * Use `--json` for machine consumption (monitoring, dashboards).
 * Use `--namespace <ns>` to drill into a single namespace and see keys.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';
import { accent, bad, dim, ok, section, table, warn } from '../ui/pretty';
import { readFlopsyConfig } from './config-reader';
import { agoLabel, resolveWorkspacePath, truncate } from '@flopsy/shared';

interface NamespaceRow {
    readonly namespace: string;
    readonly count: number;
    readonly newest_ms: number | null;
    readonly oldest_ms: number | null;
}

interface KeyRow {
    readonly key: string;
    readonly updated_at: number;
    readonly preview: string;
}

export function registerMemoryCommands(root: Command): void {
    const mem = root.command('memory').description('Inspect and diagnose agent memory');

    mem.command('kpi')
        .description('Per-namespace memory counts + freshness')
        .option('--json', 'Emit JSON for monitoring/automation')
        .option('-n, --namespace <ns>', 'Drill into a single namespace and list keys')
        .action(async (opts: { json?: boolean; namespace?: string }) => {
            readFlopsyConfig(); // validate config exists
            const dbPath = resolveWorkspacePath('state', 'memory.db');

            if (!existsSync(dbPath)) {
                if (opts.json) {
                    console.log(JSON.stringify({ error: 'no memory.db', path: dbPath }));
                } else {
                    console.log(section('Memory KPI'));
                    console.log(`  ${bad('memory.db not found')}  ${dim(`· ${dbPath}`)}`);
                    console.log(
                        `  ${dim('Run the gateway at least once to initialise the store.')}`,
                    );
                }
                return;
            }

            const db = new Database(dbPath, { readonly: true });

            try {
                if (opts.namespace) {
                    renderKeys(db, opts.namespace, opts.json);
                } else {
                    renderKpi(db, opts.json);
                }
            } finally {
                db.close();
            }
        });

    mem.command('status')
        .description(
            'Live memory configuration + per-namespace usage vs char limits.',
        )
        .option('--json', 'Emit JSON for monitoring')
        .action((opts: { json?: boolean }) => {
            const { config } = readFlopsyConfig();
            const dbPath = resolveWorkspacePath('state', 'memory.db');
            const userMdPath = resolveWorkspacePath('config', 'USER.md');

            const memCfg = (config.memory ?? {}) as {
                enabled?: boolean;
                userProfileEnabled?: boolean;
                memoryCharLimit?: number;
                userCharLimit?: number;
            };
            const memoryEnabled = memCfg.enabled !== false;
            const userProfileEnabled = memCfg.userProfileEnabled !== false;
            const memoryCharLimit = memCfg.memoryCharLimit ?? 2200;
            const userCharLimit = memCfg.userCharLimit ?? 1375;

            // Per-namespace char usage (sum of `value` lengths).
            interface UsageRow {
                readonly namespace: string;
                readonly count: number;
                readonly bytes: number;
            }
            let nsRows: UsageRow[] = [];
            if (existsSync(dbPath)) {
                const db = new Database(dbPath, { readonly: true });
                try {
                    nsRows = db
                        .prepare(
                            `SELECT namespace,
                                    COUNT(*)                      AS count,
                                    COALESCE(SUM(LENGTH(value)),0) AS bytes
                             FROM   store_items
                             GROUP  BY namespace
                             ORDER  BY bytes DESC`,
                        )
                        .all() as UsageRow[];
                } finally {
                    db.close();
                }
            }

            // USER.md file size — counted toward user_char_limit alongside
            // the `profile` namespace.
            let userMdBytes = 0;
            if (existsSync(userMdPath)) {
                try {
                    userMdBytes = require('fs').statSync(userMdPath).size as number;
                } catch { /* swallow */ }
            }

            const profileRow = nsRows.find((r) => r.namespace === 'profile');
            const userProfileChars = (profileRow?.bytes ?? 0) + userMdBytes;
            const memoryRow = nsRows.find((r) => r.namespace === 'memory');
            const memoryChars = memoryRow?.bytes ?? 0;

            if (opts.json) {
                console.log(
                    JSON.stringify(
                        {
                            memory_enabled: memoryEnabled,
                            user_profile_enabled: userProfileEnabled,
                            memory_char_limit: memoryCharLimit,
                            user_char_limit: userCharLimit,
                            memory_chars: memoryChars,
                            user_profile_chars: userProfileChars,
                            user_md_bytes: userMdBytes,
                            namespaces: nsRows,
                        },
                        null,
                        2,
                    ),
                );
                return;
            }

            console.log(section('Memory status'));
            const flag = (b: boolean): string => (b ? ok('on') : bad('off'));
            console.log(`  memory_enabled         ${flag(memoryEnabled)}`);
            console.log(`  user_profile_enabled   ${flag(userProfileEnabled)}`);
            console.log();
            renderUsageBar('memory       ', memoryChars, memoryCharLimit);
            renderUsageBar('user profile ', userProfileChars, userCharLimit);
            console.log(dim(`  (user profile = USER.md ${userMdBytes}B + profile namespace ${profileRow?.bytes ?? 0}B)`));
            console.log();

            if (nsRows.length === 0) {
                console.log(`  ${dim('no namespaces yet — memory.db is empty')}`);
                return;
            }
            console.log(section('Per-namespace usage'));
            for (const r of nsRows) {
                const pct = memoryCharLimit > 0 ? Math.round((r.bytes / memoryCharLimit) * 100) : 0;
                const tag = pct >= 80 ? warn(`${pct}%`) : pct >= 50 ? accent(`${pct}%`) : dim(`${pct}%`);
                console.log(`  ${r.namespace.padEnd(14)} ${String(r.count).padStart(4)} entries  ${String(r.bytes).padStart(6)}B  ${tag}`);
            }
        });
}

/**
 * Usage bar. Color-codes by percent used and warns when over 80 % — the
 * threshold where the agent is expected to consolidate entries before
 * adding new ones.
 */
function renderUsageBar(label: string, used: number, limit: number): void {
    if (limit <= 0) {
        console.log(`  ${label}  ${dim('no limit set')}`);
        return;
    }
    const pct = Math.min(100, Math.round((used / limit) * 100));
    const filled = Math.round((pct / 100) * 20);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    const usageStr = `${used} / ${limit}`;
    const pctTag = pct >= 80 ? bad(`${pct}%`) : pct >= 50 ? warn(`${pct}%`) : ok(`${pct}%`);
    console.log(`  ${label}  ${bar}  ${pctTag.padEnd(4)}  ${dim(usageStr)}`);
}

function renderKpi(db: Database.Database, asJson?: boolean): void {
    const rows = db
        .prepare(
            `SELECT namespace,
                    COUNT(*)           AS count,
                    MAX(updated_at)    AS newest_ms,
                    MIN(created_at)    AS oldest_ms
             FROM   store_items
             GROUP  BY namespace
             ORDER  BY count DESC`,
        )
        .all() as NamespaceRow[];

    if (asJson) {
        console.log(
            JSON.stringify(
                rows.map((r) => ({
                    namespace: r.namespace,
                    count: r.count,
                    newest: r.newest_ms ? new Date(r.newest_ms).toISOString() : null,
                    oldest: r.oldest_ms ? new Date(r.oldest_ms).toISOString() : null,
                })),
                null,
                2,
            ),
        );
        return;
    }

    console.log(section('Memory KPI'));

    if (rows.length === 0) {
        console.log(`  ${dim('no memories stored yet')}`);
        return;
    }

    const now = Date.now();
    const tableRows: string[][] = rows.map((r) => {
        const ageMs = r.newest_ms ? now - r.newest_ms : null;
        const ageFmt = ageMs !== null ? agoLabel(ageMs) : dim('—');
        const fresh = ageMs !== null && ageMs < 60 * 60 * 1_000; // < 1h
        const stale = ageMs !== null && ageMs > 7 * 24 * 60 * 60 * 1_000; // > 7d
        const countFmt = stale
            ? warn(String(r.count))
            : fresh
              ? ok(String(r.count))
              : String(r.count);
        return [
            accent('●', '#2ECC71'),
            r.namespace,
            `${countFmt} ${dim('items')}`,
            dim('newest'),
            ageFmt,
        ];
    });

    console.log(table(tableRows));
    console.log(
        `\n  ${dim('drill into a namespace:')}  ${dim('flopsy memory kpi -n <namespace>')}`,
    );
}

function renderKeys(db: Database.Database, ns: string, asJson?: boolean): void {
    const rows = db
        .prepare(
            `SELECT key,
                    updated_at,
                    SUBSTR(value, 1, 120) AS preview
             FROM   store_items
             WHERE  namespace = ?
             ORDER  BY updated_at DESC
             LIMIT  50`,
        )
        .all(ns) as KeyRow[];

    if (asJson) {
        console.log(
            JSON.stringify(
                {
                    namespace: ns,
                    count: rows.length,
                    items: rows.map((r) => ({
                        key: r.key,
                        updated: new Date(r.updated_at).toISOString(),
                        preview: r.preview,
                    })),
                },
                null,
                2,
            ),
        );
        return;
    }

    console.log(section(`Memory: ${ns}`));

    if (rows.length === 0) {
        console.log(`  ${bad(`no items in namespace "${ns}"`)}`);
        return;
    }

    const now = Date.now();
    const tableRows: string[][] = rows.map((r) => [
        dim(agoLabel(now - r.updated_at)),
        r.key,
        dim(truncate(r.preview, 60)),
    ]);

    console.log(table(tableRows));
}

