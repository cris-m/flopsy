/**
 * `flopsy status` — one-screen overview of the whole system.
 *
 * Separates *scan* (data gathering: reads flopsy.json5 + probes the running
 * gateway via mgmt HTTP) from *render* (output formatting). All three
 * renderers (compact / verbose / json) share one `StatusSnapshot` from
 * `@flopsy/shared` so the chat-side `/status` handler can reuse the same
 * shape without duplication.
 *
 * Flags:
 *   (default)    one-line-per-section compact view (~7 lines)
 *   --verbose    expanded per-section detail
 *   --json       machine-readable JSON for monitoring/CI
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
    type StatusSnapshot,
    type CliTheme,
    renderCliCompact,
    renderCliVerbose,
} from '@flopsy/shared';
import { listCredentialProviders, loadCredential } from '../auth/credential-store';
import { isColorTty } from '../ui/pretty';
import { cronJobsOf, heartbeatsOf, inboundWebhooksOf, readFlopsyConfig } from './config-reader';
import { probeGatewayState } from './gateway-state';

export function registerStatusCommand(root: Command): void {
    root.command('status')
        .description('Show a unified status snapshot of gateway, channels, MCP, auth, and team')
        .option('--verbose', 'Expanded per-section detail view')
        .option('--json', 'Emit structured JSON for monitoring/automation')
        .action(async (opts: { verbose?: boolean; json?: boolean }) => {
            const snapshot = await scanStatus();
            if (opts.json) {
                console.log(JSON.stringify(snapshot, null, 2));
                return;
            }
            const theme = buildTheme();
            if (opts.verbose) {
                console.log(renderCliVerbose(snapshot, theme));
            } else {
                console.log(renderCliCompact(snapshot, theme));
            }
        });
}

/**
 * Build a CliTheme using raw chalk — NOT the `pretty` module's ok/bad/warn
 * because those prepend log-symbols (✔/✖/⚠) that would double up with the
 * shared renderer's own markers (●/○). Keep it to pure colour.
 */
function buildTheme(): CliTheme {
    const rich = isColorTty();
    if (!rich) {
        return {
            ok: (s) => s,
            warn: (s) => s,
            bad: (s) => s,
            dim: (s) => s,
            accent: (s) => s,
            heading: (s) => s,
        };
    }
    return {
        ok: (s) => chalk.green(s),
        warn: (s) => chalk.yellow(s),
        bad: (s) => chalk.red(s),
        dim: (s) => chalk.dim(s),
        accent: (s) => chalk.hex('#9B59B6')(s),
        heading: (s) => chalk.bold.hex('#6C8EF5')(s),
    };
}

/**
 * Gather the full StatusSnapshot by reading flopsy.json5 + probing the
 * running gateway's mgmt endpoint (best-effort — config view if gateway is
 * down).
 */
async function scanStatus(): Promise<StatusSnapshot> {
    const { path: configPath, config } = readFlopsyConfig();
    const port = config.gateway?.port ?? 18789;
    const host = config.gateway?.host ?? '127.0.0.1';

    const gw = await probeGatewayState(port);
    const live = gw.running ? await fetchLive(host, port) : undefined;

    // Channels — merge config with live status from mgmt
    const liveChannels = new Map<string, { status?: string }>();
    if (live && Array.isArray((live as { channels?: unknown }).channels)) {
        for (const c of (live as { channels: Array<{ name: string; status?: string }> }).channels) {
            liveChannels.set(c.name, { status: c.status });
        }
    }
    const channels = Object.entries(config.channels ?? {}).map(([name, cfg]) => {
        const enabled = cfg?.enabled !== false;
        // If gateway is down we have no way to know the live connection state —
        // leave `status` unset rather than lying with "unknown" on every row.
        const liveStatus = liveChannels.get(name)?.status as StatusSnapshot['channels'][number]['status'] | undefined;
        const status: StatusSnapshot['channels'][number]['status'] | undefined = !enabled
            ? 'disabled'
            : liveStatus;
        return {
            name,
            enabled,
            ...(status ? { status } : {}),
        };
    });

    // Team — enrich config list with live activity
    const liveAgents = new Map<string, { state: 'idle' | 'busy'; currentTask?: string; since?: number }>();
    if (live && Array.isArray((live as { agents?: unknown }).agents)) {
        for (const a of (live as { agents: Array<{ name: string; state: 'idle' | 'busy'; currentTask?: string; since?: number }> }).agents) {
            liveAgents.set(a.name, a);
        }
    }
    const team = (config.agents ?? []).map((a) => {
        const enabled = a.enabled !== false;
        const live = liveAgents.get(a.name);
        const status: 'idle' | 'working' | 'disabled' = !enabled
            ? 'disabled'
            : live?.state === 'busy'
              ? 'working'
              : 'idle';
        return {
            name: a.name,
            enabled,
            status,
            ...(live?.currentTask ? { currentTask: live.currentTask } : {}),
            ...(live?.since ? { lastActiveAgoMs: Date.now() - live.since } : {}),
        };
    });

    // Auth
    const authProviders = listCredentialProviders();
    const auth = authProviders.map((p) => {
        const cred = loadCredential(p);
        if (!cred) return { provider: p, expiresInMinutes: 0, expired: true };
        const expiresInMinutes = Math.max(0, Math.round((cred.expiresAt - Date.now()) / 60_000));
        return {
            provider: p,
            ...(cred.email ? { email: cred.email } : {}),
            expiresInMinutes,
            expired: cred.expiresAt < Date.now(),
        };
    });

    // MCP
    const mcpServers = config.mcp?.servers ?? {};
    const mcpConfigured = Object.keys(mcpServers).length;
    const mcpActive = Object.values(mcpServers).filter((s) => s?.enabled !== false).length;

    // Proactive — counts come from config; live stats from mgmt (optional)
    const proactiveCfg = config.proactive ?? {};
    const proactiveEnabled = proactiveCfg.enabled !== false;
    const heartbeats = heartbeatsOf(config);
    const jobs = cronJobsOf(config);
    const webhookRoutes = inboundWebhooksOf(config);

    const liveProactive =
        live && typeof live['proactive'] === 'object' && live['proactive'] !== null
            ? (live['proactive'] as Record<string, unknown>)
            : undefined;

    const webhookCfg = config.webhook ?? {};
    const webhookServerEnabled = webhookCfg.enabled === true;

    // Prefer live runtime counts from /mgmt/status (which reads
    // proactive.db) — config arrays are empty in the post-migration world
    // where schedules live in proactive.db, not flopsy.json5. Fall back to
    // config arrays when the gateway is down so the CLI still shows
    // something useful offline.
    const liveHb = typeof liveProactive?.['heartbeats'] === 'number' ? (liveProactive!['heartbeats'] as number) : null;
    const liveCron = typeof liveProactive?.['cronJobs'] === 'number' ? (liveProactive!['cronJobs'] as number) : null;
    const liveWh = typeof liveProactive?.['inboundWebhooks'] === 'number' ? (liveProactive!['inboundWebhooks'] as number) : null;

    const proactive: StatusSnapshot['proactive'] = {
        enabled: proactiveEnabled,
        ...(liveProactive && typeof liveProactive['running'] === 'boolean'
            ? { running: liveProactive['running'] as boolean }
            : {}),
        heartbeats: {
            count: liveHb ?? heartbeats.length,
            enabled: liveHb ?? heartbeats.filter((h) => h?.enabled !== false).length,
            ...(typeof liveProactive?.['lastHeartbeatAt'] === 'number'
                ? { lastFireAgoMs: Date.now() - (liveProactive['lastHeartbeatAt'] as number) }
                : {}),
        },
        cron: {
            count: liveCron ?? jobs.length,
            enabled: liveCron ?? jobs.filter((j) => j?.enabled !== false).length,
            ...(typeof liveProactive?.['lastCronAt'] === 'number'
                ? { lastFireAgoMs: Date.now() - (liveProactive['lastCronAt'] as number) }
                : {}),
        },
        webhooks: {
            count: liveWh ?? webhookRoutes.length,
            enabled: webhookServerEnabled,
            ...(typeof liveProactive?.['lastWebhookAt'] === 'number'
                ? { lastReceiveAgoMs: Date.now() - (liveProactive['lastWebhookAt'] as number) }
                : {}),
        },
        ...(liveProactive?.['funnel24h'] && typeof liveProactive['funnel24h'] === 'object'
            ? {
                  stats24h: (() => {
                      const f = liveProactive['funnel24h'] as {
                          delivered?: number;
                          suppressed?: number;
                          errors?: number;
                          queued?: number;
                          retryQueue?: number;
                      };
                      return {
                          delivered: f.delivered ?? 0,
                          suppressed: f.suppressed ?? 0,
                          errors: f.errors ?? 0,
                          retryPending: f.retryQueue ?? 0,
                      };
                  })(),
              }
            : liveProactive?.['stats24h'] && typeof liveProactive['stats24h'] === 'object'
              ? { stats24h: liveProactive['stats24h'] as StatusSnapshot['proactive']['stats24h'] }
              : {}),
    };

    const gateway: StatusSnapshot['gateway'] = {
        running: gw.running,
        ...(gw.pid !== undefined ? { pid: gw.pid } : {}),
        ...(gw.uptime ? { uptimeMs: parseUptime(gw.uptime) } : {}),
        host,
        port,
        ...(live && typeof live['activeThreads'] === 'number'
            ? { activeThreads: live['activeThreads'] as number }
            : {}),
        ...(live && typeof live['version'] === 'string' ? { version: live['version'] as string } : {}),
    };

    return {
        gateway,
        channels,
        team,
        proactive,
        integrations: {
            auth,
            mcp: {
                enabled: config.mcp?.enabled !== false,
                configured: mcpConfigured,
                active: mcpActive,
            },
            memory: {
                enabled: config.memory?.enabled !== false,
                ...(config.memory?.embedder?.model ? { embedder: config.memory.embedder.model } : {}),
            },
        },
        paths: {
            config: configPath,
            state: configPath.replace(/\/[^/]+$/, '') + '/.flopsy',
        },
    };
}

/**
 * Best-effort fetch of the live management snapshot. Silently returns
 * `undefined` when the gateway isn't running or the endpoint is
 * unreachable — the CLI is expected to fall back to config-only data.
 */
async function fetchLive(host: string, port: number): Promise<Record<string, unknown> | undefined> {
    const mgmtPort = port + 1;
    const url = `http://${host}:${mgmtPort}/mgmt/status`;
    const token = process.env['FLOPSY_MGMT_TOKEN'];
    try {
        const res = await fetch(url, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) return undefined;
        return (await res.json()) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

/** Convert a human uptime string like "2h 15m" back to ms (rough). */
function parseUptime(s: string): number {
    let ms = 0;
    const d = s.match(/(\d+)d/);
    const h = s.match(/(\d+)h/);
    const m = s.match(/(\d+)m/);
    const sec = s.match(/(\d+)s/);
    if (d) ms += +d[1]! * 86_400_000;
    if (h) ms += +h[1]! * 3_600_000;
    if (m) ms += +m[1]! * 60_000;
    if (sec) ms += +sec[1]! * 1000;
    return ms;
}
