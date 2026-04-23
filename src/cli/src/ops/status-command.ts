/**
 * `flopsy status` — one-screen overview of the whole system.
 *
 * Composes probes from every subsystem so the operator can `flopsy
 * status` before and after any change and see everything that matters:
 *   - Gateway: running? pid + uptime
 *   - Channels: configured + enabled count
 *   - Auth: which providers have stored credentials + expiry
 *   - MCP:   configured server count, routed count
 *   - Team:  agents + enabled/disabled split
 *   - Memory: path + embedder
 *   - Cron/heartbeats/webhooks: enabled counts
 *
 * The output is intentionally plain-text; pipe-friendly. Use `--json`
 * for machine reading (monitoring, diagnostics dumps).
 */

import { Command } from 'commander';
import { listCredentialProviders, loadCredential } from '../auth/credential-store';
import { accent, bad, dim, link, ok, section, state, table, warn } from '../ui/pretty';
import { cronJobsOf, heartbeatsOf, inboundWebhooksOf, readFlopsyConfig } from './config-reader';
import { probeGatewayState } from './gateway-state';

export function registerStatusCommand(root: Command): void {
    root.command('status')
        .description('Show a unified status snapshot of gateway, channels, MCP, auth, and team')
        .option('--json', 'Emit structured JSON for monitoring/automation')
        .action(async (opts: { json?: boolean }) => {
            const snapshot = await gatherSnapshot();
            if (opts.json) {
                console.log(JSON.stringify(snapshot, null, 2));
                return;
            }
            await renderPlain(snapshot);
        });
}

interface StatusSnapshot {
    readonly gateway: {
        readonly running: boolean;
        readonly pid?: number;
        readonly uptime?: string;
        readonly host: string;
        readonly port: number;
    };
    readonly channels: {
        readonly enabled: readonly string[];
        readonly disabled: readonly string[];
    };
    readonly auth: ReadonlyArray<{
        readonly provider: string;
        readonly email?: string;
        readonly expiresInMinutes: number;
        readonly expired: boolean;
    }>;
    readonly mcp: {
        readonly enabled: boolean;
        readonly configured: number;
        readonly enabledCount: number;
    };
    readonly team: {
        readonly enabled: readonly string[];
        readonly disabled: readonly string[];
    };
    readonly memory: {
        readonly enabled: boolean;
        readonly embedder?: string;
    };
    readonly proactive: {
        readonly enabled: boolean;
        readonly heartbeats: number;
        readonly jobs: number;
        readonly webhooks: number;
    };
    readonly webhook: {
        readonly enabled: boolean;
        readonly host?: string;
        readonly port?: number;
    };
    readonly configPath: string;
}

async function gatherSnapshot(): Promise<StatusSnapshot> {
    const { path: configPath, config } = readFlopsyConfig();
    const port = config.gateway?.port ?? 18789;
    const host = config.gateway?.host ?? '127.0.0.1';

    const gateway = await probeGatewayState(port);
    const channels = Object.entries(config.channels ?? {}).reduce(
        (acc, [name, cfg]) => {
            if (cfg?.enabled === false) acc.disabled.push(name);
            else acc.enabled.push(name);
            return acc;
        },
        { enabled: [] as string[], disabled: [] as string[] },
    );

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

    const mcpServers = config.mcp?.servers ?? {};
    const mcpConfigured = Object.keys(mcpServers).length;
    const mcpEnabledCount = Object.values(mcpServers).filter((s) => s?.enabled !== false).length;

    const teamAgents = config.agents ?? [];
    const team = teamAgents.reduce(
        (acc, a) => {
            if (a.enabled === false) acc.disabled.push(a.name);
            else acc.enabled.push(a.name);
            return acc;
        },
        { enabled: [] as string[], disabled: [] as string[] },
    );

    const proactive = {
        enabled: config.proactive?.enabled !== false,
        heartbeats: heartbeatsOf(config).filter((h) => h?.enabled !== false).length,
        jobs: cronJobsOf(config).filter((j) => j?.enabled !== false).length,
        webhooks: inboundWebhooksOf(config).filter((w) => w?.enabled !== false).length,
    };

    const webhookCfg = config.webhook ?? {};
    const webhook = {
        enabled: webhookCfg.enabled === true,
        ...(webhookCfg.host ? { host: webhookCfg.host } : {}),
        ...(webhookCfg.port !== undefined ? { port: webhookCfg.port } : {}),
    };

    const memory = {
        enabled: config.memory?.enabled !== false,
        ...(config.memory?.embedder?.model ? { embedder: config.memory.embedder.model } : {}),
    };

    return {
        gateway: {
            running: gateway.running,
            ...(gateway.pid !== undefined ? { pid: gateway.pid } : {}),
            ...(gateway.uptime ? { uptime: gateway.uptime } : {}),
            host,
            port,
        },
        channels,
        auth,
        mcp: {
            enabled: config.mcp?.enabled !== false,
            configured: mcpConfigured,
            enabledCount: mcpEnabledCount,
        },
        team,
        memory,
        proactive,
        webhook,
        configPath,
    };
}

/**
 * Optional shape of per-agent activity pulled from `/mgmt/status`.
 * The gateway's snapshot may or may not include this field depending on
 * version; the status renderer treats it as best-effort data.
 */
interface LiveAgentActivity {
    readonly name: string;
    readonly state: 'idle' | 'busy';
    readonly currentTask?: string;
    readonly since?: number;
}

/**
 * Best-effort fetch of the live management snapshot. Silently returns
 * `undefined` when the gateway isn't running or the endpoint is
 * unreachable — the CLI is expected to fall back to config-only data.
 */
async function fetchLiveSnapshot(
    host: string,
    port: number,
): Promise<Record<string, unknown> | undefined> {
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

async function renderPlain(s: StatusSnapshot): Promise<void> {
    const live =
        s.gateway.running
            ? await fetchLiveSnapshot(s.gateway.host, s.gateway.port)
            : undefined;

    const agentActivity = new Map<string, LiveAgentActivity>();
    if (live && Array.isArray((live as { agents?: unknown }).agents)) {
        for (const a of (live as { agents: LiveAgentActivity[] }).agents) {
            agentActivity.set(a.name, a);
        }
    }
    const activeThreads =
        live && typeof live['activeThreads'] === 'number'
            ? (live['activeThreads'] as number)
            : 0;

    // Gateway header — one summary line so `flopsy status` answers
    // "is it up?" in a single glance. Vitals dot-separated and dimmed
    // so the running/not-running verdict stands out.
    if (s.gateway.running) {
        const parts = [
            ok('running'),
            dim(`pid ${s.gateway.pid}`),
            dim(`up ${s.gateway.uptime?.trim() ?? '?'}`),
            dim(`${s.gateway.host}:${s.gateway.port}`),
        ];
        if (activeThreads > 0) parts.push(state('working', `${activeThreads} turns`));
        console.log(`${section('Gateway').trim()}   ${parts.join(dim(' · '))}`);
    } else {
        console.log(
            `${section('Gateway').trim()}   ${bad('not running')}  ${dim(`· ${s.gateway.host}:${s.gateway.port}`)}  ${dim('· run `flopsy gateway start`')}`,
        );
    }

    // Channels — keep the two-row pill layout (enabled on one line,
    // disabled on the next). Visually tight: header line, pills line(s),
    // done. Count travels inline with the header.
    {
        const total = s.channels.enabled.length + s.channels.disabled.length;
        console.log(
            section(`Channels (${s.channels.enabled.length}/${total})`),
        );
        if (total === 0) {
            console.log(`  ${dim('none configured')}`);
        } else {
            if (s.channels.enabled.length > 0) {
                console.log(
                    `  ${s.channels.enabled.map((n) => `${accent('●', '#2ECC71')} ${n}`).join('   ')}`,
                );
            }
            if (s.channels.disabled.length > 0) {
                console.log(
                    `  ${s.channels.disabled.map((n) => dim(`○ ${n}`)).join('   ')}`,
                );
            }
        }
    }

    // Team — still one-per-line so idle/working/held states can hang off
    // each agent. Column-aligned via `table()` so the tag lands in the
    // same column regardless of name length.
    {
        const total = s.team.enabled.length + s.team.disabled.length;
        console.log(section(`Team (${s.team.enabled.length}/${total})`));
        if (total === 0) {
            console.log(`  ${dim('none configured')}`);
        } else {
            const rows: string[][] = [];
            for (const name of s.team.enabled) {
                const a = agentActivity.get(name);
                const tag = renderAgentTag(a, name, activeThreads, s);
                rows.push([accent('●', '#2ECC71'), name, tag.trim()]);
            }
            for (const name of s.team.disabled) {
                rows.push([dim('○'), dim(name), dim('· disabled')]);
            }
            console.log(table(rows));
        }
    }

    // Services — one row per subsystem. Each row always shows its
    // current state (including "0" counts — hiding zeros makes the
    // reader wonder if the subsystem exists at all). The proactive
    // triad (heartbeat, cron, webhook-routes) gets one row each so
    // each can be seen at a glance, with a master "disabled" marker
    // when the parent `proactive.enabled` flag is off.
    console.log(section('Services'));
    {
        const rows: string[][] = [];
        const p = s.proactive;
        const proactiveOff = !p.enabled;
        // Each service row leads with a `- <label>` bullet so the
        // Services block reads as a list, matching `flopsy team`.
        const label = (name: string) => dim(`- ${name.padEnd(9)}`);

        // Auth
        if (s.auth.length === 0) {
            rows.push([label('auth'), dim('none · run `flopsy auth <provider>`')]);
        } else {
            for (const a of s.auth) {
                const name = a.email ? `${a.provider} · ${a.email}` : a.provider;
                const remaining = `${a.expiresInMinutes}m left`;
                let tag: string;
                if (a.expired) tag = bad('expired');
                else if (a.expiresInMinutes < 60) tag = warn(remaining);
                else tag = ok(remaining);
                rows.push([label('auth'), `${name}  ${tag}`]);
            }
        }

        // MCP
        rows.push([
            label('mcp'),
            s.mcp.enabled
                ? ok(`${s.mcp.enabledCount}/${s.mcp.configured} servers enabled`)
                : bad('disabled'),
        ]);

        // Memory
        rows.push([
            label('memory'),
            s.memory.enabled
                ? `${ok('enabled')}  ${dim('· ' + (s.memory.embedder ?? 'no embedder'))}`
                : bad('disabled'),
        ]);

        // Heartbeat — always visible, count included.
        const heartbeatCell = (() => {
            if (proactiveOff) return dim('· proactive engine disabled');
            if (p.heartbeats > 0) return ok(`${p.heartbeats} active`);
            return dim('· 0 configured');
        })();
        rows.push([label('heartbeat'), heartbeatCell]);

        // Cron — always visible, count included.
        const cronCell = (() => {
            if (proactiveOff) return dim('· proactive engine disabled');
            if (p.jobs > 0) return ok(`${p.jobs} job${p.jobs > 1 ? 's' : ''}`);
            return dim('· 0 configured');
        })();
        rows.push([label('cron'), cronCell]);

        // Webhook — combines the HTTP server state with route count.
        // Two concepts: `webhook.enabled` is the server that listens;
        // `proactive.webhooks[]` is what it routes to. Shown together so
        // the reader doesn't have to cross-reference.
        {
            const serverState = s.webhook.enabled
                ? ok('listening')
                : dim('off');
            const addr = s.webhook.enabled
                ? dim(`· ${s.webhook.host ?? '127.0.0.1'}:${s.webhook.port ?? '?'}`)
                : '';
            const routes = dim(`· ${p.webhooks} route${p.webhooks === 1 ? '' : 's'}`);
            const parts = [serverState, addr, routes].filter((x) => x.length > 0);
            rows.push([label('webhook'), parts.join('  ')]);
        }

        console.log(table(rows));
    }

    // Footer — paths, quietly dimmed. Clickable via OSC 8 on terminals
    // that support it (iTerm2 / WezTerm / Kitty / Gnome).
    console.log('');
    const harnessDir = s.configPath.replace(/\/[^/]+$/, '') + '/.flopsy/harness';
    const footerRows: string[][] = [
        [dim('config'), link(s.configPath, tildePath(s.configPath))],
        [dim('state'), link(harnessDir, tildePath(harnessDir))],
    ];
    console.log(table(footerRows));
    console.log('');
}

/**
 * Collapse the user's home directory to `~` so long paths stay readable.
 * Kept local — banner.ts has a similar helper; no value in a shared util
 * just yet.
 */
function tildePath(p: string): string {
    const home = process.env['HOME'];
    if (home && (p === home || p.startsWith(home + '/'))) {
        return '~' + p.slice(home.length);
    }
    return p;
}

/**
 * Decide the trailing tag for an agent row. Uses live activity data when
 * available, otherwise a conservative fallback based on the gateway's
 * global `activeThreads` count.
 */
function renderAgentTag(
    activity: LiveAgentActivity | undefined,
    agentName: string,
    activeThreads: number,
    snapshot: StatusSnapshot,
): string {
    // Cyan `⟳ working: <task>` for busy agents — the rotating arrow glyph
    // reads as motion; yellow `⚠` felt wrong here since "busy" isn't a
    // warning. Empty idle state stays dim to not compete for attention.
    if (activity) {
        if (activity.state === 'busy') {
            const label = activity.currentTask
                ? `working: ${truncate(activity.currentTask, 40)}`
                : 'working';
            return `  ${state('working', label)}`;
        }
        return `  ${dim('· idle')}`;
    }
    if (activeThreads > 0) {
        const isMain = snapshot.team.enabled[0] === agentName;
        return isMain ? `  ${state('working', 'working')}` : `  ${dim('· idle')}`;
    }
    return `  ${dim('· idle')}`;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}
