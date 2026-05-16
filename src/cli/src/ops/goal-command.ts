import { Command } from 'commander';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';
import { accent, bad, dim, ok, section, table, warn } from '../ui/pretty';
import { readFlopsyConfig } from './config-reader';
import { agoLabel, resolveWorkspacePath, truncate } from '@flopsy/shared';

interface DbGoalRow {
    readonly thread_id: string;
    readonly goal: string;
    readonly status: 'active' | 'paused' | 'done' | 'cleared';
    readonly turns_used: number;
    readonly max_turns: number;
    readonly parse_failures: number;
    readonly created_at: number;
    readonly last_turn_at: number;
    readonly last_verdict: string | null;
    readonly last_reason: string | null;
    readonly channel_name: string;
    readonly peer_id: string;
}

function openDbOrExit(): Database.Database | null {
    readFlopsyConfig();
    const dbPath = resolveWorkspacePath('state', 'learning.db');
    if (!existsSync(dbPath)) {
        console.log(warn('learning.db not found at ' + dbPath));
        console.log(dim('Run the gateway once to create the database.'));
        return null;
    }
    return new Database(dbPath, { readonly: false });
}

function statusBadge(s: DbGoalRow['status'], now: number, last: number): string {
    if (s === 'active') return accent('active');
    if (s === 'done') return ok('done');
    if (s === 'paused') return warn('paused');
    return dim('cleared');
}

export function registerGoalCommands(root: Command): void {
    const goal = root
        .command('goal')
        .description('Inspect + manage standing /goal Ralph-loop sessions');

    goal
        .command('list', { isDefault: true })
        .description('List standing goals across threads (active first)')
        .option('--all', 'Include done/cleared goals')
        .option('--peer <id>', 'Filter to one peer routing key')
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
                    filters.push("status IN ('active','paused')");
                }
                if (opts.peer) {
                    filters.push('peer_id = ?');
                    params.push(opts.peer);
                }
                const where = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';
                params.push(limit);
                const rows = db
                    .prepare(
                        `SELECT * FROM session_goals
                         ${where}
                         ORDER BY
                           CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                           last_turn_at DESC
                         LIMIT ?`,
                    )
                    .all(...params) as DbGoalRow[];

                if (opts.json) {
                    console.log(JSON.stringify(rows, null, 2));
                    return;
                }
                if (rows.length === 0) {
                    console.log(
                        section('Goals') + '\n  ' + dim(opts.all ? 'No goals recorded.' : 'No active or paused goals. Use --all to see done/cleared.'),
                    );
                    return;
                }
                const now = Date.now();
                console.log(section('Goals') + '  ' + dim(`(${rows.length} rows)`));
                console.log(
                    table([
                        ['thread', 'status', 'turns', 'last', 'verdict', 'goal'],
                        ...rows.map((r) => [
                            truncate(r.thread_id, 28),
                            statusBadge(r.status, now, r.last_turn_at),
                            `${r.turns_used}/${r.max_turns}`,
                            agoLabel(now - r.last_turn_at) + ' ago',
                            r.last_verdict ?? dim('—'),
                            truncate(r.goal, 50),
                        ]),
                    ]),
                );
            } finally {
                db.close();
            }
        });

    goal
        .command('show <thread>')
        .description('Print full goal row for a thread (including last reason)')
        .option('--json', 'Emit JSON')
        .action((threadId: string, opts: { json?: boolean }) => {
            const db = openDbOrExit();
            if (!db) return;
            try {
                const row = db
                    .prepare('SELECT * FROM session_goals WHERE thread_id = ?')
                    .get(threadId) as DbGoalRow | undefined;
                if (!row) {
                    console.log(warn(`No goal for thread ${threadId}`));
                    return;
                }
                if (opts.json) {
                    console.log(JSON.stringify(row, null, 2));
                    return;
                }
                const now = Date.now();
                console.log(section('Goal · ' + threadId));
                console.log('  ' + dim('status     ') + statusBadge(row.status, now, row.last_turn_at));
                console.log('  ' + dim('budget     ') + `${row.turns_used}/${row.max_turns} turns`);
                console.log('  ' + dim('parse fail ') + String(row.parse_failures));
                console.log('  ' + dim('channel    ') + row.channel_name);
                console.log('  ' + dim('peer       ') + row.peer_id);
                console.log('  ' + dim('created    ') + agoLabel(now - row.created_at) + ' ago');
                console.log('  ' + dim('last turn  ') + agoLabel(now - row.last_turn_at) + ' ago');
                if (row.last_verdict) {
                    console.log('  ' + dim('last       ') + row.last_verdict + (row.last_reason ? ` · ${row.last_reason}` : ''));
                }
                console.log('  ' + dim('goal       ') + row.goal);
            } finally {
                db.close();
            }
        });

    goal
        .command('clear <thread>')
        .description('Delete the standing goal for a thread')
        .action((threadId: string) => {
            const db = openDbOrExit();
            if (!db) return;
            try {
                const result = db
                    .prepare('DELETE FROM session_goals WHERE thread_id = ?')
                    .run(threadId);
                if (result.changes > 0) {
                    console.log(ok(`Cleared goal for ${threadId}`));
                } else {
                    console.log(warn(`No goal found for ${threadId}`));
                }
            } finally {
                db.close();
            }
        });

    goal
        .command('pause <thread>')
        .description('Pause the standing goal for a thread (stops Ralph loop)')
        .action((threadId: string) => {
            const db = openDbOrExit();
            if (!db) return;
            try {
                const result = db
                    .prepare(`UPDATE session_goals SET status = 'paused' WHERE thread_id = ?`)
                    .run(threadId);
                if (result.changes > 0) {
                    console.log(ok(`Paused goal for ${threadId}`));
                } else {
                    console.log(warn(`No goal found for ${threadId}`));
                }
            } finally {
                db.close();
            }
        });

    goal
        .command('resume <thread>')
        .description('Resume a paused goal (turn counter reset)')
        .action((threadId: string) => {
            const db = openDbOrExit();
            if (!db) return;
            try {
                const result = db
                    .prepare(
                        `UPDATE session_goals
                            SET status = 'active', turns_used = 0, parse_failures = 0
                          WHERE thread_id = ?`,
                    )
                    .run(threadId);
                if (result.changes > 0) {
                    console.log(ok(`Resumed goal for ${threadId} (counter reset)`));
                    console.log(dim('Send any message in the channel to drive the next turn.'));
                } else {
                    console.log(bad(`No goal found for ${threadId}`));
                }
            } finally {
                db.close();
            }
        });
}
