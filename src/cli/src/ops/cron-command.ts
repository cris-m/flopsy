/**
 * `flopsy cron` — full CRUD over runtime cron jobs in proactive.db.
 *
 * Same data model as heartbeats: stored in `~/.flopsy/state/proactive.db`,
 * writes go through the gateway's mgmt HTTP endpoint. Three flavours of
 * schedule: `--at <epoch-ms>` (fires once), `--every <ms>` (fixed interval),
 * or `--cron "<expr>" --tz <IANA>` (5-field cron expression).
 */

import { Command } from 'commander';
import { truncate } from '@flopsy/shared';
import { bad, detail, dim } from '../ui/pretty';
import {
    mgmtCreate,
    mgmtDisable,
    mgmtEnable,
    mgmtRemove,
} from './schedule-client';
import {
    renderFires,
    renderScheduleList,
    renderScheduleShow,
    renderStats,
} from './schedule-stats-render';

export function registerCronCommands(root: Command): void {
    const cron = root.command('cron').description('Manage runtime cron jobs');

    cron.command('list')
        .description('List every cron job + enabled state')
        .action(() => renderList());

    cron.command('show')
        .description('Show full detail for one cron job')
        .argument('<id>', 'Cron job id')
        .action((id: string) => renderOne(id));

    cron.command('add')
        .description('Create a cron job (at | every | cron expression)')
        .option('--id <id>', 'Stable id (defaults to runtime-cron-<ts>-<rand>)')
        .option('--name <name>', 'Human-readable label')
        .option('--at <epoch-ms>', 'Fire ONCE at absolute epoch ms')
        .option('--every <ms>', 'Fire every N ms (min 60000)')
        .option('--cron <expr>', '5-field cron expression (e.g. "0 9 * * MON")')
        .option('--tz <tz>', 'IANA timezone for cron expressions')
        .option('--message <text>', 'Inline prompt the agent receives')
        .option('--prompt-file <path>', 'Path to a prompt file (copied into workspace)')
        .option('--delivery-mode <mode>', 'always | conditional | silent', 'always')
        .option('--oneshot', 'Fire once then auto-disable', false)
        .option('--thread-id <id>', 'Reuse a thread for agent memory across fires')
        .action(async (opts) => {
            const schedule = buildCronSchedule(opts);
            if (typeof schedule === 'string') {
                console.log(bad(schedule));
                process.exit(1);
            }
            const scheduleId: string =
                opts.id ??
                `runtime-cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await mgmtCreate({
                kind: 'cron',
                id: scheduleId,
                name: opts.name,
                schedule,
                message: opts.message,
                promptFile: opts.promptFile,
                deliveryMode: opts.deliveryMode,
                oneshot: opts.oneshot,
                threadId: opts.threadId,
            });
        });

    cron.command('disable')
        .description('Disable a cron job by id')
        .argument('<id>', 'Cron job id')
        .action((id: string) => void mgmtDisable(id));

    cron.command('enable')
        .description('Re-enable a cron job by id')
        .argument('<id>', 'Cron job id')
        .action((id: string) => void mgmtEnable(id));

    cron.command('remove')
        .alias('rm')
        .description('Delete a cron job by id')
        .argument('<id>', 'Cron job id')
        .action((id: string) => void mgmtRemove(id));

    cron.command('stats')
        .description('Runs / delivered / suppressed counters; pass id for detail')
        .argument('[id]', 'Optional cron id for per-schedule detail')
        .action((id?: string) => void renderStats('cron', id));

    cron.command('fires')
        .description('Recent delivery history for one cron job')
        .argument('<id>', 'Cron job id')
        .option('--limit <n>', 'Max rows (default 20, max 500)', '20')
        .action((id: string, opts: { limit?: string }) =>
            void renderFires(id, Number(opts.limit ?? 20)),
        );

    cron.action(() => renderList());
}

function renderList(): void {
    renderScheduleList('cron', {
        title: 'Cron jobs',
        emptyLabel: 'cron',
        addHint: 'flopsy cron add --help',
        middleCells: (r, cfg) => {
            const name = (cfg['name'] as string | undefined) ?? r.id;
            return [name, dim(describeSchedule(cfg)), dim(r.id)];
        },
    });
}

function renderOne(id: string): void {
    renderScheduleShow('cron', id, {
        label: 'cron job',
        listCmd: 'flopsy cron list',
        nameOf: (r, cfg) => (cfg['name'] as string | undefined) ?? r.id,
        renderDetails: (_r, cfg) => {
            console.log(detail('schedule', describeSchedule(cfg)));
            const payload = (cfg['payload'] ?? {}) as Record<string, unknown>;
            if (payload['deliveryMode'])
                console.log(detail('deliveryMode', String(payload['deliveryMode'])));
            if (payload['oneshot']) console.log(detail('oneshot', 'yes'));
            if (payload['promptFile'])
                console.log(detail('promptFile', String(payload['promptFile'])));
            if (typeof payload['message'] === 'string')
                console.log(detail('message', truncate(payload['message'] as string, 200)));
            if (payload['threadId']) console.log(detail('threadId', String(payload['threadId'])));
        },
    });
}

function describeSchedule(cfg: Record<string, unknown>): string {
    const s = cfg['schedule'] as
        | { kind?: string; expr?: string; tz?: string; everyMs?: number; atMs?: number }
        | undefined;
    if (!s) return '(no schedule)';
    if (s.kind === 'at' && s.atMs) return `at ${new Date(s.atMs).toISOString()}`;
    if (s.kind === 'every' && s.everyMs) return `every ${s.everyMs}ms`;
    if (s.kind === 'cron' && s.expr) return `cron "${s.expr}"${s.tz ? ` (${s.tz})` : ''}`;
    return '(unknown schedule kind)';
}

function buildCronSchedule(opts: {
    at?: string;
    every?: string;
    cron?: string;
    tz?: string;
}):
    | { kind: 'at'; atMs: number }
    | { kind: 'every'; everyMs: number }
    | { kind: 'cron'; expr: string; tz?: string }
    | string {
    const set = [opts.at, opts.every, opts.cron].filter(Boolean).length;
    if (set === 0) return 'Specify one of --at | --every | --cron';
    if (set > 1) return 'Specify exactly one of --at | --every | --cron';
    if (opts.at !== undefined) {
        const atMs = Number(opts.at);
        if (!Number.isFinite(atMs)) return '--at must be an epoch millisecond number';
        if (atMs <= Date.now()) return '--at must be in the future';
        return { kind: 'at', atMs };
    }
    if (opts.every !== undefined) {
        const everyMs = Number(opts.every);
        if (!Number.isFinite(everyMs) || everyMs < 60_000)
            return '--every must be >= 60000 (60 seconds)';
        return { kind: 'every', everyMs };
    }
    if (opts.cron !== undefined) {
        return { kind: 'cron', expr: opts.cron, ...(opts.tz ? { tz: opts.tz } : {}) };
    }
    return 'Unreachable';
}
