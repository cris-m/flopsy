/**
 * `flopsy heartbeat` — inspect heartbeats from `proactive.heartbeats`.
 *
 * Heartbeats are periodic pings the agent fires itself (e.g. "check
 * the log, say hi on Monday 9am"). Different from cron in that the
 * interval is relative ("every 1h") and usually ignored as ambient
 * ticks, not scheduled-calendar tasks.
 */

import { Command } from 'commander';
import { bad, detail, dim, row, section, table } from '../ui/pretty';
import { heartbeatsOf, readFlopsyConfig, type RawHeartbeat } from './config-reader';
import { tint } from '../ui/theme';

export function registerHeartbeatCommands(root: Command): void {
    const hb = root
        .command('heartbeat')
        .alias('hb')
        .description('Inspect configured heartbeats (periodic agent pings)');

    hb.command('list')
        .description('List every configured heartbeat + enabled state')
        .action(() => {
            const { config } = readFlopsyConfig();
            renderList(heartbeatsOf(config));
        });

    hb.command('show')
        .description('Detailed view of one heartbeat')
        .argument('<name>', 'Heartbeat name')
        .action((name: string) => {
            const { config } = readFlopsyConfig();
            const hbEntry = heartbeatsOf(config).find((h) => h.name === name);
            if (!hbEntry) {
                console.log(bad(`No heartbeat named "${name}" in flopsy.json5.`));
                process.exit(1);
            }
            renderOne(hbEntry);
        });

    hb.action(() => {
        const { config } = readFlopsyConfig();
        renderList(heartbeatsOf(config));
    });
}

function renderList(items: ReadonlyArray<RawHeartbeat>): void {
    console.log(section('Heartbeats'));
    if (items.length === 0) {
        console.log(row('beats', dim('no heartbeats configured')));
        return;
    }
    const rows: string[][] = items.map((h) => {
        const enabled = h.enabled !== false;
        const dot = enabled ? tint.success('●') : dim('○');
        const name = h.name ?? '(unnamed)';
        const displayName = enabled ? name : dim(name);
        const interval = h.interval ? dim(h.interval) : dim('(no interval)');
        const tag = h.oneshot ? dim('one-shot') : '';
        return [dot, displayName, interval, tag];
    });
    console.log(table(rows));
}

function renderOne(h: RawHeartbeat): void {
    const enabled = h.enabled !== false;
    const dot = enabled ? tint.success('●') : dim('○');
    const name = h.name ?? '(unnamed)';
    const displayName = enabled ? name : dim(name);
    const state = enabled ? dim('enabled') : dim('disabled');
    console.log(section(`Heartbeat: ${name}`, 'success'));
    console.log(`  ${dot} ${displayName}  ${state}`);
    console.log(detail('interval', h.interval ?? '(none)'));
    console.log(detail('oneshot', h.oneshot ? 'yes' : 'no'));
    if (h.deliveryMode) console.log(detail('delivery', h.deliveryMode));
    if (h.message) console.log(detail('message', h.message));
}
