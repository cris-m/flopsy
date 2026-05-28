/**
 * `flopsy mcp ...` — manage entries in the `mcp.servers` block of
 * flopsy.json5.
 *
 * Pure config management — does NOT spawn or test the server. Spawning
 * happens at gateway startup via the loader. To exercise a server
 * end-to-end, restart the gateway.
 *
 * Commands:
 *   flopsy mcp list                          — names + enabled flag
 *   flopsy mcp show [name]                   — JSON dump (one or all)
 *   flopsy mcp set <name> <json>             — add or replace
 *   flopsy mcp remove <name>                 — delete entry
 *   flopsy mcp enable <name> / disable <name> — flip the enabled flag
 */

import { readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Command } from 'commander';
import JSON5 from 'json5';
import { configPath } from '../ops/config-reader';
import { dim, section, table } from '../ui/pretty';
import { tint } from '../ui/theme';
import { MCP_CATALOG, getCatalogEntry, type McpCatalogEntry } from './catalog';

function fail(msg: string, code = 1): never {
    process.stderr.write(`error: ${msg}\n`);
    process.exit(code);
}

interface RawConfig {
    mcp?: { servers?: Record<string, unknown> };
    [k: string]: unknown;
}

function readConfig(): { path: string; raw: string; parsed: RawConfig } {
    const path = configPath();
    let raw: string;
    try {
        raw = readFileSync(path, 'utf-8');
    } catch (err) {
        fail(`Cannot read config at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed: RawConfig;
    try {
        parsed = JSON5.parse(raw) as RawConfig;
    } catch (err) {
        fail(`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { path, raw, parsed };
}

/**
 * Re-serialise as JSON (NOT JSON5) and write — losing comments. The
 * tradeoff: round-tripping JSON5 with comments preserved is hard, and
 * `flopsy mcp set` is for programmatic / quick edits. Hand-curated
 * config users edit flopsy.json5 directly with their editor.
 *
 * We DO atomic-write via .tmp + rename so a crash doesn't leave a
 * truncated config.
 */
function writeConfig(path: string, parsed: RawConfig): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(parsed, null, 4) + '\n');
    renameSync(tmp, path);
}

function ensureMcpBlock(parsed: RawConfig): Record<string, unknown> {
    parsed.mcp ??= {};
    parsed.mcp.servers ??= {};
    return parsed.mcp.servers;
}

export function registerMcpCommands(root: Command): void {
    const mcp = root.command('mcp').description('Manage MCP server registry in flopsy.json5')
        .action((_opts: unknown, cmd: Command) => cmd.outputHelp());

    mcp.command('list')
        .description('List configured MCP servers and their enabled status')
        .action(() => {
            const { parsed } = readConfig();
            const servers = parsed.mcp?.servers ?? {};
            const names = Object.keys(servers).sort();
            console.log(section('MCP servers'));
            if (names.length === 0) {
                console.log(dim('  none configured'));
                console.log(dim('  run `flopsy mcp set <name> <json>` to add one'));
                return;
            }
            const rows: string[][] = names.map((name) => {
                const cfg = servers[name] as { enabled?: boolean; transport?: string };
                const enabled = cfg.enabled !== false;
                const dot = enabled ? tint.success('●') : dim('○');
                const displayName = enabled ? name : dim(name);
                const transport = dim(`(${cfg.transport ?? 'stdio'})`);
                return [dot, displayName, transport];
            });
            console.log(table(rows));
        });

    mcp.command('show')
        .description('Show one MCP server config (or all if no name given)')
        .argument('[name]', 'MCP server name')
        .action((name: string | undefined) => {
            const { parsed } = readConfig();
            const servers = parsed.mcp?.servers ?? {};
            if (name) {
                const cfg = servers[name];
                if (!cfg) fail(`No MCP server named "${name}".`);
                console.log(JSON.stringify(cfg, null, 2));
            } else {
                console.log(JSON.stringify(servers, null, 2));
            }
        });

    mcp.command('set')
        .description('Add or replace an MCP server entry. JSON value follows the schema.')
        .argument('<name>', 'MCP server name (lowercase, hyphens allowed)')
        .argument(
            '<json>',
            'Server JSON, e.g. \'{"command":"npx","args":["-y","@some/mcp"]}\'',
        )
        .action((name: string, jsonStr: string) => {
            if (!/^[a-z][a-z0-9-]*$/.test(name)) {
                fail('Server name must match /^[a-z][a-z0-9-]*$/ (lowercase + hyphens).');
            }
            let parsedValue: unknown;
            try {
                parsedValue = JSON5.parse(jsonStr);
            } catch (err) {
                fail(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (typeof parsedValue !== 'object' || parsedValue === null || Array.isArray(parsedValue)) {
                fail('JSON value must be an object.');
            }
            const { path, parsed } = readConfig();
            const servers = ensureMcpBlock(parsed);
            servers[name] = parsedValue;
            writeConfig(path, parsed);
            console.log(`✓ Saved MCP server "${name}" to ${path}.`);
            console.log('Restart the gateway for the change to take effect.');
        });

    mcp.command('remove')
        .description('Delete an MCP server entry')
        .argument('<name>', 'MCP server name')
        .action((name: string) => {
            const { path, parsed } = readConfig();
            const servers = parsed.mcp?.servers as Record<string, unknown> | undefined;
            if (!servers || !servers[name]) {
                fail(`No MCP server named "${name}".`);
            }
            delete servers[name];
            writeConfig(path, parsed);
            console.log(`✓ Removed MCP server "${name}" from ${path}.`);
        });

    mcp.command('enable')
        .description('Set enabled=true on an MCP server')
        .argument('<name>', 'MCP server name')
        .action((name: string) => flipEnabled(name, true));

    mcp.command('disable')
        .description('Set enabled=false on an MCP server')
        .argument('<name>', 'MCP server name')
        .action((name: string) => flipEnabled(name, false));

    mcp.command('routes')
        .description('Print a matrix showing which agent sees which MCP server')
        .option('--json', 'Emit raw JSON instead of the pretty table')
        .action((opts: { json?: boolean }) => printRoutes(Boolean(opts.json)));

    mcp.command('catalog')
        .description('List curated MCP servers available for `flopsy mcp install <name>`')
        .action(() => {
            const { parsed } = readConfig();
            const installed = (parsed.mcp?.servers ?? {}) as Record<string, { enabled?: boolean }>;
            const rows = MCP_CATALOG.map((e) => {
                const has = installed[e.name];
                const status = !has
                    ? dim('available')
                    : has.enabled === false
                      ? dim('installed (disabled)')
                      : tint.success('installed');
                return [e.name, status, e.description];
            });
            console.log(section('MCP CATALOG'));
            console.log(table(rows));
            console.log(dim('\nInstall with `flopsy mcp install <name>` — prompts for any keys, applies live.'));
        });

    mcp.command('install')
        .description('Install a catalog MCP server: prompts for credentials, writes the entry, applies live')
        .argument('<name>', 'Catalog entry name (see `flopsy mcp catalog`)')
        .option('--disabled', 'Install but leave disabled (enable later with `flopsy mcp enable`)')
        .action(async (name: string, opts: { disabled?: boolean }) => {
            const entry = getCatalogEntry(name);
            if (!entry) {
                fail(`No catalog entry "${name}". Run \`flopsy mcp catalog\` to list available servers.`);
            }
            await installCatalogEntry(entry, { disabled: Boolean(opts.disabled) });
        });
}

function envFilePath(): string {
    // .env lives at the workspace parent (repo root) where the gateway reads it.
    const cfg = configPath();
    // configPath → <root>/.flopsy/config/flopsy.json5 ; walk up to <root>.
    const root = cfg.split('/.flopsy/')[0] ?? process.cwd();
    return join(root, '.env');
}

function upsertEnvVar(key: string, value: string): string {
    const path = envFilePath();
    let body = '';
    try {
        body = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    } catch {
        body = '';
    }
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    const next = re.test(body)
        ? body.replace(re, line)
        : (body.endsWith('\n') || body === '' ? body : body + '\n') + line + '\n';
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, next, { mode: 0o600 });
    renameSync(tmp, path);
    return path;
}

function ask(question: string, opts: { secret?: boolean } = {}): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        if (opts.secret) {
            // Mute echo: intercept the output stream while typing.
            const out = process.stdout;
            const mutableRl = rl as unknown as { _writeToOutput?: (s: string) => void };
            mutableRl._writeToOutput = (s: string): void => {
                if (s.includes(question)) out.write(s);
            };
        }
        rl.question(`${question}: `, (answer) => {
            rl.close();
            if (opts.secret) process.stdout.write('\n');
            resolve(answer.trim());
        });
    });
}

async function installCatalogEntry(
    entry: McpCatalogEntry,
    opts: { disabled: boolean },
): Promise<void> {
    console.log(section(`INSTALL ${entry.name}`));
    console.log(`  ${entry.displayName} — ${entry.description}`);
    console.log(dim(`  source: ${entry.source}`));
    console.log(dim(`  runs:   ${entry.command} ${entry.args.join(' ')}\n`));

    // Resolve prompts: arg-tokens substituted inline; env-tokens written to .env.
    const argSubs = new Map<string, string>();
    for (const p of entry.prompts ?? []) {
        const value = await ask(`  ${p.label}`, { secret: p.secret });
        if (!value) fail(`"${p.label}" is required — aborting.`);
        if (p.target === 'arg') {
            argSubs.set(p.token, value);
        } else {
            const path = upsertEnvVar(p.token, value);
            console.log(dim(`  ✓ wrote ${p.token} to ${path}`));
        }
    }

    const resolvedArgs = entry.args.map((a) => {
        const m = a.match(/^\$\{([A-Z0-9_]+)\}$/);
        if (m && argSubs.has(m[1]!)) return argSubs.get(m[1]!)!;
        return a;
    });

    const serverEntry: Record<string, unknown> = {
        enabled: !opts.disabled,
        transport: entry.transport,
        command: entry.command,
        args: resolvedArgs,
    };
    if (entry.env) serverEntry.env = { ...entry.env };

    const { path, parsed } = readConfig();
    const servers = ensureMcpBlock(parsed);
    if ((servers as Record<string, unknown>)[entry.name]) {
        console.log(dim(`  note: replacing existing "${entry.name}" entry`));
    }
    (servers as Record<string, unknown>)[entry.name] = serverEntry;
    writeConfig(path, parsed);

    console.log(tint.success(`\n✓ Installed "${entry.name}"${opts.disabled ? ' (disabled)' : ''} → ${path}`));
    console.log(
        dim(
            'A running gateway hot-reloads MCP on config change — the server connects within ~2s, no restart.\n' +
            'If the gateway is not running, it will load on next start.',
        ),
    );
}

function flipEnabled(name: string, value: boolean): void {
    const { path, parsed } = readConfig();
    const servers = parsed.mcp?.servers as Record<string, Record<string, unknown>> | undefined;
    if (!servers || !servers[name]) {
        fail(`No MCP server named "${name}".`);
    }
    servers[name].enabled = value;
    writeConfig(path, parsed);

    // Render: `<name>  (transport)  <status>` — no leading dot.
    // `table()` handles ANSI-aware column padding.
    const transport = dim(`(${(servers[name].transport as string) ?? 'stdio'})`);
    const status = value ? tint.success('● running') : dim('○ disabled');
    const displayName = value ? name : dim(name);
    console.log(table([[displayName, transport, status]]));
}

// `mcp routes` — matrix view of which agent sees which MCP server's tools.
// Resolution logic mirrors `filterToolsForAgent` in src/team/src/mcp/tool-bridge:
//   1. If agent.mcpServers is set and non-empty → use that allow-list (pull).
//   2. Otherwise → include if server.assignTo includes agentName or '*' (push).
// Disabled servers are called out but not expanded across columns (they
// don't route to anyone regardless of config).

type RouteReason = 'pull-allowlist' | 'push-assignTo' | 'wildcard' | 'not-routed' | 'disabled';

interface RouteCell {
    readonly reason: RouteReason;
    readonly included: boolean;
}

interface AgentLite {
    readonly name: string;
    readonly enabled: boolean;
    readonly mcpServers?: readonly string[];
}

interface ServerLite {
    readonly name: string;
    readonly enabled: boolean;
    readonly assignTo: readonly string[];
}

function extractConfig(): { agents: AgentLite[]; servers: ServerLite[]; path: string } {
    const { path, parsed } = readConfig();

    const rawAgents = (parsed as { agents?: unknown }).agents;
    const agents: AgentLite[] = Array.isArray(rawAgents)
        ? rawAgents
              .map((a): AgentLite | null => {
                  if (typeof a !== 'object' || a === null) return null;
                  const rec = a as Record<string, unknown>;
                  if (typeof rec.name !== 'string') return null;
                  return {
                      name: rec.name,
                      enabled: rec.enabled !== false,
                      mcpServers: Array.isArray(rec.mcpServers)
                          ? (rec.mcpServers.filter((s) => typeof s === 'string') as string[])
                          : undefined,
                  };
              })
              .filter((a): a is AgentLite => a !== null)
        : [];

    const rawServers = (parsed.mcp?.servers ?? {}) as Record<string, unknown>;
    const servers: ServerLite[] = Object.entries(rawServers).map(([name, raw]) => {
        const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const assignTo = Array.isArray(rec.assignTo)
            ? (rec.assignTo.filter((s) => typeof s === 'string') as string[])
            : [];
        return {
            name,
            enabled: rec.enabled !== false,
            assignTo,
        };
    });

    return { agents, servers, path };
}

function routeCell(agent: AgentLite, server: ServerLite): RouteCell {
    if (!server.enabled) return { reason: 'disabled', included: false };
    // 1. Agent-side allow-list (pull)
    if (agent.mcpServers && agent.mcpServers.length > 0) {
        const included = agent.mcpServers.includes(server.name);
        return { reason: included ? 'pull-allowlist' : 'not-routed', included };
    }
    // 2. Server-side push
    if (server.assignTo.includes('*')) return { reason: 'wildcard', included: true };
    if (server.assignTo.includes(agent.name)) return { reason: 'push-assignTo', included: true };
    return { reason: 'not-routed', included: false };
}

function printRoutes(asJson: boolean): void {
    const { agents, servers, path } = extractConfig();

    if (asJson) {
        const matrix = servers.map((s) => ({
            server: s.name,
            enabled: s.enabled,
            agents: Object.fromEntries(
                agents.map((a) => [a.name, routeCell(a, s)]),
            ),
        }));
        console.log(JSON.stringify({ path, matrix }, null, 2));
        return;
    }

    if (servers.length === 0) {
        console.log('No MCP servers configured. Run `flopsy mcp set <name> <json>` to add one.');
        return;
    }
    if (agents.length === 0) {
        console.log('No agents configured in flopsy.json5. Nothing to route.');
        return;
    }

    const enabledAgents = agents.filter((a) => a.enabled);
    const agentNames = enabledAgents.map((a) => a.name);

    // Column widths — server name gets padded to longest; agents are fixed.
    const nameColWidth = Math.max(
        6,
        ...servers.map((s) => s.name.length),
    );
    const agentColWidth = Math.max(10, ...agentNames.map((n) => n.length));

    const header =
        'Server'.padEnd(nameColWidth) +
        '  ' +
        agentNames.map((n) => n.padEnd(agentColWidth)).join('');
    const divider =
        '─'.repeat(nameColWidth) +
        '  ' +
        agentNames.map(() => '─'.repeat(agentColWidth)).join('');

    console.log(`MCP routing — ${path}\n`);
    console.log(header);
    console.log(divider);
    const REASON_TAGS: Partial<Record<RouteReason, string>> = {
        'pull-allowlist': 'pull',
        'push-assignTo': 'push',
        wildcard: 'wild',
    };
    for (const server of servers) {
        const cells = enabledAgents.map((agent) => {
            const cell = routeCell(agent, server);
            if (!server.enabled) return '(off)'.padEnd(agentColWidth);
            const glyph = cell.included ? '✓' : '·';
            const tag = REASON_TAGS[cell.reason] ?? '';
            const cellText = cell.included ? `${glyph} ${tag}` : glyph;
            return cellText.padEnd(agentColWidth);
        });
        console.log(server.name.padEnd(nameColWidth) + '  ' + cells.join(''));
    }

    // Footer — surface disabled servers separately so the matrix stays aligned.
    const disabled = servers.filter((s) => !s.enabled).map((s) => s.name);
    if (disabled.length > 0) {
        console.log(`\nDisabled (not routed): ${disabled.join(', ')}`);
    }

    console.log('\nLegend:  ✓ = routed    · = not routed    (off) = server disabled');
    console.log('         pull = agent.mcpServers allow-list');
    console.log('         push = server.assignTo includes this agent');
    console.log('         wild = server.assignTo includes "*"');
}
