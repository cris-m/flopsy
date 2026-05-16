/**
 * `flopsy commitments` — inspect + manage inferred follow-ups from chat.
 *
 * Commitments are conversation-bound future check-ins the agent infers
 * from your turns (e.g. "I have an interview tomorrow" → "how did it go?").
 * They live in `learning.db` (`proactive_commitments` table) and are
 * surfaced by smart-pulse when their `due_at_ms` elapses.
 *
 * This CLI reads the table directly — no gateway needed.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';
import { accent, bad, dim, ok, section, table, warn } from '../ui/pretty';
import { readFlopsyConfig } from './config-reader';
import { agoLabel, resolveWorkspacePath, truncate } from '@flopsy/shared';

interface DbCommitmentRow {
    readonly id: number;
    readonly peer_id: string;
    readonly scope: string;
    readonly channel: string;
    readonly agent_id: string;
    readonly follow_up: string;
    readonly due_at_ms: number;
    readonly confidence: number;
    readonly source_turn_id: string | null;
    readonly status: 'pending' | 'delivered' | 'dismissed' | 'expired';
    readonly created_at: number;
    readonly resolved_at: number | null;
}

function openDbOrExit(): Database.Database | null {
    readFlopsyConfig(); // validate config exists
    const dbPath = resolveWorkspacePath('state', 'learning.db');
    if (!existsSync(dbPath)) {
        console.log(warn('learning.db not found at ' + dbPath));
        console.log(dim('Run the gateway once to create the database.'));
        return null;
    }
    return new Database(dbPath, { readonly: false });
}

function fmtDue(nowMs: number, dueAtMs: number): string {
    const delta = nowMs - dueAtMs;
    if (delta < 0) return `in ${agoLabel(-delta)}`;
    return agoLabel(delta) + ' ago';
}

export function registerCommitmentsCommands(root: Command): void {
    const cmt = root
        .command('commitments')
        .description('Inspect inferred follow-ups extracted from chat turns');

    // Default action: list pending + recent.
    cmt
        .description(
            'List inferred follow-ups (pending by default; use --all for full history)',
        )
        .option('--all', 'Include delivered/dismissed/expired commitments')
        .option('--peer <id>', 'Filter to one peer (e.g. telegram chat id)')
        .option('--limit <n>', 'Cap rows shown', '20')
        .option('--json', 'Emit JSON')
        .action((opts: { all?: boolean; peer?: string; limit?: string; json?: boolean }) => {
            const db = openDbOrExit();
            if (!db) return;
            try {
                const limit = Math.max(1, Math.min(200, parseInt(opts.limit ?? '20', 10) || 20));
                const filters: string[] = [];
                const params: Array<string | number> = [];
                if (!opts.all) {
                    filters.push("status = 'pending'");
                }
                if (opts.peer) {
                    filters.push('peer_id = ?');
                    params.push(opts.peer);
                }
                const where = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';
                params.push(limit);
                const rows = db
                    .prepare(
                        `SELECT * FROM proactive_commitments
                         ${where}
                         ORDER BY due_at_ms ASC, created_at DESC
                         LIMIT ?`,
                    )
                    .all(...params) as DbCommitmentRow[];

                if (opts.json) {
                    console.log(JSON.stringify(rows, null, 2));
                    return;
                }
                if (rows.length === 0) {
                    console.log(
                        section('Commitments') +
                            '\n  ' +
                            dim(
                                opts.all
                                    ? 'No commitments yet — chat with the agent (and enable commitments.enabled in config).'
                                    : 'No pending commitments. Use --all to see resolved/expired ones.',
                            ),
                    );
                    return;
                }

                const now = Date.now();
                console.log(section('Commitments') + '  ' + dim(`(${rows.length} rows)`));
                console.log(
                    table([
                        ['id', 'status', 'due', 'conf', 'channel', 'follow_up'],
                        ...rows.map((r) => [
                            String(r.id),
                            r.status === 'pending'
                                ? r.due_at_ms <= now
                                    ? accent('due-now')
                                    : 'pending'
                                : r.status === 'delivered'
                                    ? ok('delivered')
                                    : r.status === 'dismissed'
                                        ? warn('dismissed')
                                        : dim('expired'),
                            fmtDue(now, r.due_at_ms),
                            r.confidence.toFixed(2),
                            r.channel,
                            truncate(r.follow_up, 60),
                        ]),
                    ]),
                );
            } finally {
                db.close();
            }
        });

    cmt
        .command('dismiss <id>')
        .description('Mark a pending commitment as dismissed so it stops surfacing')
        .action((id: string) => {
            const db = openDbOrExit();
            if (!db) return;
            try {
                const numId = parseInt(id, 10);
                if (!Number.isInteger(numId) || numId <= 0) {
                    console.log(bad('Invalid id: ' + id));
                    return;
                }
                const result = db
                    .prepare(
                        `UPDATE proactive_commitments
                            SET status = 'dismissed', resolved_at = ?
                          WHERE id = ? AND status = 'pending'`,
                    )
                    .run(Date.now(), numId);
                if (result.changes > 0) {
                    console.log(ok(`Dismissed commitment ${numId}`));
                } else {
                    console.log(
                        warn(`No pending commitment with id ${numId} (already resolved, or wrong id)`),
                    );
                }
            } finally {
                db.close();
            }
        });
}
