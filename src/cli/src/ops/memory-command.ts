/**
 * `flopsy memory kpi` — per-namespace memory stats from the SQLite store.
 *
 * Reads `.flopsy/harness/memory.db` directly (no gateway required).
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
            const dbPath = resolveWorkspacePath('harness', 'memory.db');

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

