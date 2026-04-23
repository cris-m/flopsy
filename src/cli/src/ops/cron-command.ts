/**
 * `flopsy cron` / `flopsy heartbeat` / `flopsy webhook` — read-only
 * peek into the `proactive` and `webhook` config sections.
 *
 * Live add/remove + start/stop of individual jobs waits for the
 * gateway's RPC plane (future work) — these operations would either
 * edit the config on disk (forces restart) or call a control endpoint.
 * For now, show-only.
 */

import { Command } from 'commander';
import { bad, detail, dim, row, section, table } from '../ui/pretty';
import { cronJobsOf, readFlopsyConfig, type RawCronJob } from './config-reader';
import { tint } from '../ui/theme';

export function registerCronCommands(root: Command): void {
    const cron = root.command('cron').description('Inspect scheduled cron jobs');

    cron.command('list')
        .description('List every configured cron job + enabled state')
        .action(() => {
            const { config } = readFlopsyConfig();
            renderCronList(cronJobsOf(config));
        });

    cron.command('show')
        .description('Detailed view of one cron job')
        .argument('<name>', 'Cron job name')
        .action((name: string) => {
            const { config } = readFlopsyConfig();
            const job = cronJobsOf(config).find((j) => j.name === name);
            if (!job) {
                console.log(bad(`No cron job named "${name}" in flopsy.json5.`));
                process.exit(1);
            }
            renderCronOne(job);
        });

    cron.action(() => {
        const { config } = readFlopsyConfig();
        renderCronList(cronJobsOf(config));
    });
}

function renderCronList(jobs: ReadonlyArray<RawCronJob>): void {
    console.log(section('Cron jobs'));
    if (jobs.length === 0) {
        console.log(row('jobs', dim('no cron jobs configured')));
        return;
    }
    const rows: string[][] = jobs.map((j) => {
        const enabled = j.enabled !== false;
        const dot = enabled ? tint.proactive('●') : dim('○');
        const name = j.name ?? '(unnamed)';
        const displayName = enabled ? name : dim(name);
        const schedule = j.schedule ? dim(j.schedule) : dim('(no schedule)');
        return [dot, displayName, schedule];
    });
    console.log(table(rows));
}

function renderCronOne(j: RawCronJob): void {
    const enabled = j.enabled !== false;
    const dot = enabled ? tint.proactive('●') : dim('○');
    const name = j.name ?? '(unnamed)';
    const displayName = enabled ? name : dim(name);
    const state = enabled ? dim('enabled') : dim('disabled');
    console.log(section(`Cron: ${name}`, 'proactive'));
    console.log(`  ${dot} ${displayName}  ${state}`);
    console.log(detail('schedule', j.schedule ?? '(none)'));
    if (j.deliveryMode) console.log(detail('delivery', j.deliveryMode));
    if (j.message) console.log(detail('message', j.message));
}
