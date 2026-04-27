/**
 * `flopsy mgmt ...` — live queries against the running gateway's
 * management HTTP endpoint.
 *
 * Companion to `flopsy status` (config-only). When the gateway is
 * running, `mgmt status` hits the live process so you see truth:
 * which channels actually connected, how many threads are instantiated,
 * today's token totals, etc.
 *
 * Auth: `FLOPSY_MGMT_TOKEN` env var (optional). Gateway binds localhost
 * only so the socket isn't reachable off-box.
 */

import { Command } from 'commander';
import { bad, dim, info, ok, row, section } from '../ui/pretty';
import { mgmtUrl } from './schedule-client';

export function registerMgmtCommands(root: Command): void {
    const mgmt = root
        .command('mgmt')
        .description('Live queries against the running gateway (ping / status)');

    mgmt.command('ping')
        .description('Verify the gateway mgmt endpoint is responding')
        .action(async () => {
            const url = mgmtUrl('/mgmt/ping');
            try {
                const res = await fetchWithAuth(url);
                const body = await res.json();
                console.log(section('Gateway ping', '#9B59B6'));
                console.log(row('endpoint', url));
                console.log(row('status', ok(String(res.status))));
                console.log(row('response', JSON.stringify(body)));
            } catch (err) {
                console.log(section('Gateway ping', '#9B59B6'));
                console.log(row('endpoint', url));
                console.log(row('status', bad('unreachable')));
                console.log(
                    row('hint', dim(err instanceof Error ? err.message : String(err))),
                );
                process.exit(1);
            }
        });

    mgmt.command('status')
        .description('Live status snapshot from the running gateway')
        .option('--json', 'Emit raw JSON')
        .action(async (opts: { json?: boolean }) => {
            const url = mgmtUrl('/mgmt/status');
            try {
                const res = await fetchWithAuth(url);
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                const snap = await res.json();
                if (opts.json) {
                    console.log(JSON.stringify(snap, null, 2));
                    return;
                }
                renderSnapshot(snap as Record<string, unknown>);
            } catch (err) {
                console.log(
                    bad(
                        `live status unavailable (${err instanceof Error ? err.message : String(err)}).`,
                    ),
                );
                console.log(info('gateway not running? try `flopsy status` for config-only view.'));
                process.exit(1);
            }
        });
}

async function fetchWithAuth(url: string): Promise<Response> {
    const token = process.env['FLOPSY_MGMT_TOKEN'];
    return fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(3000),
    });
}

/**
 * Render the live snapshot. Shape comes from gateway's getStatusSnapshot()
 * which already carries channels + counts. Kept loose (Record<string, unknown>)
 * to not couple the CLI tightly to a type that's still evolving.
 */
function renderSnapshot(snap: Record<string, unknown>): void {
    console.log(section('Gateway (live)', '#9B59B6'));
    const version = snap['version'];
    const uptimeMs = snap['uptimeMs'] as number | undefined;
    if (version) console.log(row('build', String(version)));
    if (uptimeMs !== undefined)
        console.log(row('uptime', `${Math.round(uptimeMs / 1000)}s`));
    const port = snap['port'];
    if (port !== undefined) console.log(row('port', String(port)));

    const channels = snap['channels'] as ReadonlyArray<Record<string, unknown>> | undefined;
    if (Array.isArray(channels)) {
        console.log(section('Channels (live)', '#3498DB'));
        for (const ch of channels) {
            const name = ch['name'] as string;
            const status = ch['status'] as string;
            const enabled = ch['enabled'] !== false;
            const cell = enabled && status === 'connected' ? ok(status ?? 'ok') : bad(status ?? 'down');
            console.log(row(name, cell));
        }
    }

    const webhook = snap['webhook'] as Record<string, unknown> | undefined;
    if (webhook) {
        console.log(section('Webhook (live)', '#E67E22'));
        console.log(row('state', webhook['enabled'] ? ok('on') : dim('off')));
        if (webhook['routeCount'] !== undefined) {
            console.log(row('routes', String(webhook['routeCount'])));
        }
    }

    const proactive = snap['proactive'] as Record<string, unknown> | undefined;
    if (proactive) {
        console.log(section('Proactive (live)', '#1ABC9C'));
        console.log(row('running', proactive['running'] ? ok('yes') : bad('no')));
        if (proactive['heartbeats'] !== undefined) {
            console.log(row('heartbeats', String(proactive['heartbeats'])));
        }
        if (proactive['cronJobs'] !== undefined) {
            console.log(row('cron jobs', String(proactive['cronJobs'])));
        }
    }
}
