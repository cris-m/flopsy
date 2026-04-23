/**
 * `flopsy webhook` — inspect the webhook receiver config.
 *
 * FlopsyBot has TWO webhook concepts:
 *   - `webhook` — the inbound HTTP server (host/port/secret) that accepts
 *     external callbacks. One per gateway.
 *   - `proactive.webhooks` — individual routes registered on that server
 *     (each fires a pre-defined agent task).
 *
 * Both are displayed here.
 */

import { Command } from 'commander';
import { dim, ok, row, section, table } from '../ui/pretty';
import { inboundWebhooksOf, readFlopsyConfig, type RawInboundWebhook } from './config-reader';
import { tint } from '../ui/theme';

export function registerWebhookCommands(root: Command): void {
    const wh = root.command('webhook').description('Inspect the webhook server + routes');

    wh.command('show')
        .description('Show webhook receiver config (host/port/enabled)')
        .action(() => {
            const { config } = readFlopsyConfig();
            const cfg = config.webhook ?? {};
            console.log(section('Webhook receiver', '#E67E22'));
            console.log(
                row(
                    'state',
                    cfg.enabled === true ? ok('enabled') : dim('off'),
                ),
            );
            if (cfg.enabled === true) {
                console.log(row('address', `${cfg.host ?? '127.0.0.1'}:${cfg.port ?? '?'}`));
                if (cfg.allowedIps && cfg.allowedIps.length > 0) {
                    console.log(row('allowed ips', cfg.allowedIps.join(', ')));
                }
                if (cfg.secret) {
                    console.log(
                        row('secret', dim('(set — ' + String(cfg.secret).slice(0, 2) + '***)')),
                    );
                }
            }
        });

    wh.command('list')
        .description('List individual webhook routes from proactive.webhooks')
        .action(() => {
            const { config } = readFlopsyConfig();
            renderRoutes(inboundWebhooksOf(config));
        });

    wh.action(() => {
        const { config } = readFlopsyConfig();
        const cfg = config.webhook ?? {};
        console.log(section('Webhook receiver', '#E67E22'));
        console.log(
            row('state', cfg.enabled === true ? ok('enabled') : dim('off')),
        );
        if (cfg.enabled === true) {
            console.log(row('address', `${cfg.host ?? '127.0.0.1'}:${cfg.port ?? '?'}`));
        }
        renderRoutes(inboundWebhooksOf(config));
    });
}

function renderRoutes(routes: ReadonlyArray<RawInboundWebhook>): void {
    console.log(section('Webhook routes'));
    if (routes.length === 0) {
        console.log(row('routes', dim('no routes configured under proactive.webhooks')));
        return;
    }
    const rows: string[][] = routes.map((w) => {
        const enabled = w.enabled !== false;
        const dot = enabled ? tint.webhook('●') : dim('○');
        const name = w.name ?? '(unnamed)';
        const displayName = enabled ? name : dim(name);
        const path = w.path ? dim(w.path) : dim('(no path)');
        return [dot, displayName, path];
    });
    console.log(table(rows));
}
