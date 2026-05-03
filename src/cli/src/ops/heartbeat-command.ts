/**
 * `flopsy heartbeat` — full CRUD over runtime heartbeats in proactive.db.
 *
 * Reads work offline (direct DB access); writes go through the gateway's
 * mgmt HTTP endpoint so the live engine hot-registers the change without
 * a restart.
 */

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
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

export function registerHeartbeatCommands(root: Command): void {
    const hb = root
        .command('heartbeat')
        .alias('hb')
        .description('Manage runtime heartbeats (periodic agent pings)');

    hb.command('list')
        .description('List every heartbeat + enabled state')
        .action(() => renderList());

    hb.command('show')
        .description('Show full detail for one heartbeat')
        .argument('<id>', 'Heartbeat id (from `flopsy heartbeat list`)')
        .action((id: string) => renderOne(id));

    hb.command('add')
        .description('Create a heartbeat (fires on a fixed interval)')
        .requiredOption('--name <name>', 'Heartbeat name')
        .requiredOption('--interval <duration>', '"30s" | "5m" | "1h" | "1d"')
        .option('--prompt <text>', 'Inline prompt the agent receives')
        .option('--prompt-file <path>', 'Path to a prompt file (copied into workspace)')
        .option('--delivery-mode <mode>', 'always | conditional | silent', 'always')
        .option('--oneshot', 'Fire once then auto-disable', false)
        .option('--id <id>', 'Stable id (defaults to runtime-hb-<name>)')
        .action(async (opts) => {
            // Resolve --prompt-file to absolute against the user's CWD —
            // the daemon runs in a different cwd and would otherwise hit
            // ENOENT when it tries to copy the file into the workspace.
            let absPromptFile: string | undefined;
            if (opts.promptFile) {
                absPromptFile = resolvePath(opts.promptFile);
                if (!existsSync(absPromptFile)) {
                    console.log(bad(`prompt-file not found: ${absPromptFile}`));
                    process.exit(1);
                }
            }
            const scheduleId: string = opts.id ?? `runtime-hb-${opts.name as string}`;
            await mgmtCreate({
                kind: 'heartbeat',
                id: scheduleId,
                name: opts.name,
                interval: opts.interval,
                prompt: opts.prompt,
                promptFile: absPromptFile,
                deliveryMode: opts.deliveryMode,
                oneshot: opts.oneshot,
            });
        });

    hb.command('disable')
        .description('Disable a heartbeat by id')
        .argument('<id>', 'Heartbeat id')
        .action((id: string) => void mgmtDisable(id));

    hb.command('enable')
        .description('Re-enable a heartbeat by id')
        .argument('<id>', 'Heartbeat id')
        .action((id: string) => void mgmtEnable(id));

    hb.command('remove')
        .alias('rm')
        .description('Delete a heartbeat by id')
        .argument('<id>', 'Heartbeat id')
        .action((id: string) => void mgmtRemove(id));

    hb.command('stats')
        .description('Runs / delivered / suppressed counters; pass id for detail')
        .argument('[id]', 'Optional heartbeat id for per-schedule detail')
        .action((id?: string) => void renderStats('heartbeat', id));

    hb.command('fires')
        .description('Recent delivery history for one heartbeat')
        .argument('<id>', 'Heartbeat id')
        .option('--limit <n>', 'Max rows (default 20, max 500)', '20')
        .action((id: string, opts: { limit?: string }) =>
            void renderFires(id, Number(opts.limit ?? 20)),
        );

    hb.action(() => renderList());
}

function renderList(): void {
    renderScheduleList('heartbeat', {
        title: 'Heartbeats',
        emptyLabel: 'heartbeats',
        addHint: 'flopsy heartbeat add --help',
        middleCells: (r, cfg) => {
            const name = (cfg['name'] as string | undefined) ?? '(no name)';
            const interval = (cfg['interval'] as string | undefined) ?? '—';
            return [name, dim(interval), dim(r.id)];
        },
    });
}

function renderOne(id: string): void {
    renderScheduleShow('heartbeat', id, {
        label: 'heartbeat',
        listCmd: 'flopsy heartbeat list',
        nameOf: (_r, cfg) => (cfg['name'] as string | undefined) ?? '(no name)',
        renderDetails: (_r, cfg) => {
            if (cfg['interval']) console.log(detail('interval', String(cfg['interval'])));
            if (cfg['deliveryMode']) console.log(detail('deliveryMode', String(cfg['deliveryMode'])));
            if (cfg['oneshot']) console.log(detail('oneshot', 'yes'));
            if (cfg['promptFile']) console.log(detail('promptFile', String(cfg['promptFile'])));
            if (cfg['prompt']) console.log(detail('prompt', truncate(String(cfg['prompt']), 200)));
        },
    });
}
