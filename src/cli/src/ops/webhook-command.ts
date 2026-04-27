/**
 * `flopsy webhook` — full CRUD over runtime inbound webhooks.
 *
 * Each webhook registers an HTTP path on the gateway's webhook server.
 * When an external service POSTs to that path, the body is routed into
 * the target channel worker's event queue as a `task_complete` event.
 *
 * Writes go through the mgmt HTTP endpoint so the live gateway registers
 * the route without a restart. Reads use proactive.db directly (offline).
 */

import { Command } from 'commander';
import { detail, dim } from '../ui/pretty';
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

export function registerWebhookCommands(root: Command): void {
    const wh = root.command('webhook').description('Manage inbound webhook endpoints');

    wh.command('list')
        .description('List every runtime webhook + enabled state')
        .action(() => renderList());

    wh.command('show')
        .description('Show full detail for one webhook')
        .argument('<id>', 'Webhook id (= its name)')
        .action((id: string) => renderOne(id));

    wh.command('add')
        .description('Register an inbound webhook endpoint')
        .requiredOption('--name <name>', 'Webhook id / label (e.g. "github-releases")')
        .requiredOption(
            '--path <path>',
            'URL path on the webhook server (must start with "/")',
        )
        .requiredOption(
            '--target-channel <name>',
            'Channel whose worker receives the event (e.g. "telegram")',
        )
        .option('--secret <secret>', 'HMAC secret for signature verification')
        .option(
            '--event-type-header <header>',
            'Header carrying the event type (e.g. "x-github-event")',
        )
        .action(async (opts) => {
            await mgmtCreate({
                kind: 'webhook',
                name: opts.name,
                path: opts.path,
                targetChannel: opts.targetChannel,
                secret: opts.secret,
                eventTypeHeader: opts.eventTypeHeader,
            });
        });

    wh.command('disable')
        .description('Disable a webhook by id')
        .argument('<id>', 'Webhook id')
        .action((id: string) => void mgmtDisable(id));

    wh.command('enable')
        .description('Re-enable a webhook by id')
        .argument('<id>', 'Webhook id')
        .action((id: string) => void mgmtEnable(id));

    wh.command('remove')
        .alias('rm')
        .description('Remove a webhook (unregisters the HTTP route)')
        .argument('<id>', 'Webhook id')
        .action((id: string) => void mgmtRemove(id));

    wh.command('stats')
        .description('Runs / delivered / suppressed counters; pass id for detail')
        .argument('[id]', 'Optional webhook id for per-schedule detail')
        .action((id?: string) => void renderStats('webhook', id));

    wh.command('fires')
        .description('Recent delivery history for one webhook')
        .argument('<id>', 'Webhook id')
        .option('--limit <n>', 'Max rows (default 20, max 500)', '20')
        .action((id: string, opts: { limit?: string }) =>
            void renderFires(id, Number(opts.limit ?? 20)),
        );

    wh.action(() => renderList());
}

function renderList(): void {
    renderScheduleList('webhook', {
        title: 'Webhooks',
        emptyLabel: 'webhooks',
        addHint: 'flopsy webhook add --help',
        middleCells: (r, cfg) => {
            const name = (cfg['name'] as string | undefined) ?? r.id;
            const path = (cfg['path'] as string | undefined) ?? '—';
            const target = (cfg['targetChannel'] as string | undefined) ?? '—';
            return [name, dim(path), dim(`→ ${target}`)];
        },
    });
}

function renderOne(id: string): void {
    renderScheduleShow('webhook', id, {
        label: 'webhook',
        listCmd: 'flopsy webhook list',
        nameOf: (r, cfg) => (cfg['name'] as string | undefined) ?? r.id,
        renderDetails: (_r, cfg) => {
            if (cfg['path']) console.log(detail('path', String(cfg['path'])));
            if (cfg['targetChannel'])
                console.log(detail('target channel', String(cfg['targetChannel'])));
            if (cfg['secret']) console.log(detail('secret', dim('(set — hidden)')));
            if (cfg['eventTypeHeader'])
                console.log(detail('event type header', String(cfg['eventTypeHeader'])));
        },
    });
}
