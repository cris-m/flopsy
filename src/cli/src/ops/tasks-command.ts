/**
 * `flopsy tasks` — inspect in-flight and recent background tasks across
 * every thread. Data comes from the running gateway's `/mgmt/tasks`
 * endpoint — this command cannot operate offline.
 *
 * Surfaces:
 *   - Teammate delegations (gandalf → legolas, saruman, …)
 *   - Fire-and-forget background jobs
 *   - Shell command tasks
 *
 * Useful for debugging: why is a worker stuck? what failed recently?
 * what has the leader been dispatching?
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { agoLabel, truncate } from '@flopsy/shared';
import { bad, dim, info, ok, section } from '../ui/pretty';
import { mgmtUrl } from './schedule-client';

interface TaskRow {
    readonly id: string;
    readonly threadId: string;
    readonly worker: string;
    readonly description: string;
    readonly status: 'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'killed';
    readonly startedAtMs: number;
    readonly endedAtMs?: number;
    readonly error?: string;
}

export function registerTasksCommand(root: Command): void {
    const tasks = root
        .command('tasks')
        .description('Inspect in-flight + recent background tasks across every thread');

    tasks
        .command('list', { isDefault: true })
        .description('List tasks (default: active + recent, up to 20)')
        .option('--active', 'Show only active (pending/running/idle) tasks')
        .option('--recent', 'Show only completed tasks')
        .option('--failed', 'Show only failed + killed tasks')
        .option('--thread <id>', 'Filter to a single thread id')
        .option('--limit <n>', 'Max rows to return (default 20, max 500)')
        .option('--json', 'Emit JSON for scripting')
        .action(async (opts: {
            active?: boolean;
            recent?: boolean;
            failed?: boolean;
            thread?: string;
            limit?: string;
            json?: boolean;
        }) => {
            const filters = buildFilters(opts);
            const rows = await fetchTasks(filters);
            if (opts.json) {
                console.log(JSON.stringify({ tasks: rows }, null, 2));
                return;
            }
            renderList(rows);
        });

    tasks
        .command('show')
        .description('Show full detail for one task')
        .argument('<id>', 'Task id (from `flopsy tasks list`)')
        .action(async (id: string) => {
            const rows = await fetchTasks({ limit: '500' });
            const row = rows.find((r) => r.id === id);
            if (!row) {
                console.log(bad(`No task with id "${id}". Use \`flopsy tasks\` to list.`));
                process.exit(1);
            }
            renderDetail(row);
        });
}

function buildFilters(opts: {
    active?: boolean;
    recent?: boolean;
    failed?: boolean;
    thread?: string;
    limit?: string;
}): Record<string, string> {
    const params: Record<string, string> = {};
    if (opts.active) params['status'] = 'pending,running,idle';
    else if (opts.failed) params['status'] = 'failed,killed';
    else if (opts.recent) params['status'] = 'completed,failed,killed';
    if (opts.thread) params['thread'] = opts.thread;
    params['limit'] = opts.limit ?? '20';
    return params;
}

async function fetchTasks(params: Record<string, string>): Promise<TaskRow[]> {
    const qs = new URLSearchParams(params).toString();
    const url = mgmtUrl(`/mgmt/tasks${qs ? '?' + qs : ''}`);
    const token = process.env['FLOPSY_MGMT_TOKEN'];
    try {
        const res = await fetch(url, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
            const msg = (body['error'] as string) ?? `HTTP ${res.status}`;
            console.log(bad(msg));
            if (res.status === 501) {
                console.log(info('The agent layer does not implement queryAllTasks yet.'));
            }
            process.exit(1);
        }
        const body = (await res.json()) as { tasks?: TaskRow[] };
        return body.tasks ?? [];
    } catch (err) {
        const hint = err instanceof Error ? err.message : String(err);
        console.log(bad(`mgmt endpoint unreachable at ${url}`));
        console.log(info(`gateway not running? start it with \`flopsy gateway start\`. hint: ${hint}`));
        process.exit(1);
    }
}

function renderList(rows: readonly TaskRow[]): void {
    if (rows.length === 0) {
        console.log(dim('No tasks match. Gateway idle, or filter excluded everything.'));
        return;
    }
    const now = Date.now();
    const active = rows.filter((r) => isActive(r.status));
    const done = rows.filter((r) => !isActive(r.status));

    if (active.length > 0) {
        console.log(section(`Active (${active.length})`));
        for (const r of active) {
            const icon = activeIcon(r.status);
            const age = agoLabel(now - r.startedAtMs).replace(' ago', '');
            const where = chalk.dim(`[${shortThread(r.threadId)}]`);
            console.log(
                `  ${icon} ${chalk.bold(r.id)}  ${where}  ${r.worker.padEnd(12)}  ${truncate(r.description, 60)}  ${dim(age)}`,
            );
        }
    }

    if (done.length > 0) {
        console.log(section(`Recent (${done.length})`));
        for (const r of done) {
            const icon = doneIcon(r.status);
            const age = r.endedAtMs ? agoLabel(now - r.endedAtMs) : '?';
            const where = chalk.dim(`[${shortThread(r.threadId)}]`);
            const tag = r.status === 'failed' || r.status === 'killed' ? bad(r.status) : ok(r.status);
            const errorBit = r.error ? dim(` — ${truncate(r.error, 50)}`) : '';
            console.log(
                `  ${icon} ${chalk.bold(r.id)}  ${where}  ${r.worker.padEnd(12)}  ${truncate(r.description, 50)}  ${tag} ${dim(age)}${errorBit}`,
            );
        }
    }
}

function renderDetail(r: TaskRow): void {
    const now = Date.now();
    console.log(section(`Task ${r.id}`));
    console.log(`  id           ${r.id}`);
    console.log(`  thread       ${r.threadId}`);
    console.log(`  worker       ${r.worker}`);
    console.log(`  status       ${colorStatus(r.status)}`);
    console.log(`  description  ${r.description}`);
    console.log(`  started      ${agoLabel(now - r.startedAtMs)} (${new Date(r.startedAtMs).toISOString()})`);
    if (r.endedAtMs) {
        const durationMs = r.endedAtMs - r.startedAtMs;
        console.log(`  ended        ${agoLabel(now - r.endedAtMs)} (duration ${fmtMs(durationMs)})`);
    }
    if (r.error) console.log(`  error        ${bad(r.error)}`);
}

function isActive(status: TaskRow['status']): boolean {
    return status === 'pending' || status === 'running' || status === 'idle';
}

function activeIcon(status: TaskRow['status']): string {
    switch (status) {
        case 'running': return chalk.cyan('▶');
        case 'idle': return chalk.yellow('⏸');
        case 'pending': return chalk.yellow('◷');
        default: return '·';
    }
}

function doneIcon(status: TaskRow['status']): string {
    switch (status) {
        case 'completed': return chalk.green('✓');
        case 'failed': return chalk.red('✗');
        case 'killed': return chalk.red('⊘');
        default: return '·';
    }
}

function colorStatus(status: TaskRow['status']): string {
    switch (status) {
        case 'running': return chalk.cyan(status);
        case 'idle': return chalk.yellow(status);
        case 'pending': return chalk.yellow(status);
        case 'completed': return chalk.green(status);
        case 'failed': return chalk.red(status);
        case 'killed': return chalk.red(status);
        default: return status;
    }
}

function shortThread(threadId: string): string {
    // Thread ids are typically "<channel>:<peer-id>" — show last 8 chars of
    // peer so the table stays readable while still disambiguating threads.
    if (threadId.length <= 20) return threadId;
    const colon = threadId.indexOf(':');
    if (colon < 0) return threadId.slice(0, 20) + '…';
    return threadId.slice(0, colon + 1) + '…' + threadId.slice(-8);
}

function fmtMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
}
