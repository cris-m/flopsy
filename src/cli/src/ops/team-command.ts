/**
 * `flopsy team` — inspect the agent roster from flopsy.json5.
 *
 * Read-only. For LIVE per-thread state (who's running a task right now),
 * use `/status` in a chat (the gateway exposes it there).
 */

import { Command } from 'commander';
import { renameSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import { truncate } from '@flopsy/shared';
import { bad, detail, dim, info, ok, row, section } from '../ui/pretty';
import { readFlopsyConfig, type ModelRef, type RawAgent } from './config-reader';
import { mgmtUrl } from './schedule-client';
import { tint } from '../ui/theme';

/** Format a ModelRef back into a "provider:name" string for display. */
function fmtModel(m: ModelRef | undefined): string | undefined {
    if (!m?.name) return undefined;
    return m.provider ? `${m.provider}:${m.name}` : m.name;
}

export function registerTeamCommands(root: Command): void {
    const team = root.command('team').description('Inspect and manage the configured agent team');

    team.command('list')
        .description('Show every configured agent + role + enabled state (+ live activity when gateway is running)')
        .option('--no-live', 'Skip the live-activity probe (config view only)')
        .action(async (opts: { live: boolean }) => {
            const { config } = readFlopsyConfig();
            const live = opts.live !== false ? await fetchLiveAgents() : new Map();
            renderList(config.agents ?? [], buildPushMap(config.mcp?.servers ?? {}), live);
        });

    team.command('show')
        .description('Detailed view of a single agent')
        .argument('<name>', 'Agent name')
        .action((name: string) => {
            const { config } = readFlopsyConfig();
            const agent = (config.agents ?? []).find((a) => a.name === name);
            if (!agent) {
                console.log(bad(`No agent named "${name}" in flopsy.json5.`));
                process.exit(1);
            }
            renderOne(agent, buildPushMap(config.mcp?.servers ?? {}));
        });

    team.command('enable')
        .description('Enable an agent (sets enabled=true in flopsy.json5)')
        .argument('<name>', 'Agent name')
        .action((name: string) => writeAgentField(name, 'enabled', true));

    team.command('disable')
        .description('Disable an agent (sets enabled=false in flopsy.json5)')
        .argument('<name>', 'Agent name')
        .action((name: string) => writeAgentField(name, 'enabled', false));

    team.command('set')
        .description('Set a field on an agent; <value> is JSON-parsed, else string')
        .argument('<name>', 'Agent name (e.g. legolas)')
        .argument('<field>', 'Field path, e.g. `model`, `model_config.temperature`, `approvals.tools`')
        .argument('<value>', 'JSON literal (true, 123, [..]) or plain string')
        .action((name: string, field: string, rawValue: string) => {
            const parsed = parseValue(rawValue);
            writeAgentField(name, field, parsed);
        });

    // Default: `flopsy team` with no subcommand → list (with live probe).
    team.action(async () => {
        const { config } = readFlopsyConfig();
        const live = await fetchLiveAgents();
        renderList(config.agents ?? [], buildPushMap(config.mcp?.servers ?? {}), live);
    });
}

// ── Live probe ───────────────────────────────────────────────────────────

type LiveAgentMap = Map<string, { state: 'idle' | 'busy'; currentTask?: string }>;

async function fetchLiveAgents(): Promise<LiveAgentMap> {
    const url = mgmtUrl('/mgmt/status');
    const token = process.env['FLOPSY_MGMT_TOKEN'];
    const out: LiveAgentMap = new Map();
    try {
        const res = await fetch(url, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) return out;
        const body = (await res.json()) as { agents?: Array<{ name: string; state: 'idle' | 'busy'; currentTask?: string }> };
        for (const a of body.agents ?? []) {
            out.set(a.name, {
                state: a.state,
                ...(a.currentTask ? { currentTask: a.currentTask } : {}),
            });
        }
    } catch {
        /* gateway unreachable — config view only */
    }
    return out;
}

// ── Writes ───────────────────────────────────────────────────────────────

function writeAgentField(name: string, field: string, value: unknown): void {
    const { path: file, config } = readFlopsyConfig();
    const cfg = config as Record<string, unknown>;
    const agents = (cfg['agents'] as Array<Record<string, unknown>> | undefined) ?? [];
    const idx = agents.findIndex((a) => a['name'] === name);
    if (idx < 0) {
        console.log(bad(`No agent named "${name}" in flopsy.json5.`));
        process.exit(1);
    }
    setByPath(agents[idx]!, field, value);
    atomicWrite(file, cfg);
    console.log(ok(`set agents.${name}.${field} = ${prettyValue(value)}`));
    console.log(dim(`wrote ${file}`));
    console.log(info('restart the gateway to apply: `flopsy gateway restart`'));
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .filter((s) => s.length > 0);
    const last = parts.pop();
    if (!last) throw new Error('empty path');
    let cur: Record<string, unknown> | unknown[] = obj;
    for (const part of parts) {
        if (Array.isArray(cur)) {
            const i = Number(part);
            if (!Number.isInteger(i)) throw new Error(`expected array index, got "${part}"`);
            if (cur[i] === undefined || typeof cur[i] !== 'object' || cur[i] === null) cur[i] = {};
            cur = cur[i] as Record<string, unknown> | unknown[];
        } else {
            if (cur[part] === undefined || typeof cur[part] !== 'object' || cur[part] === null) {
                cur[part] = {};
            }
            cur = cur[part] as Record<string, unknown> | unknown[];
        }
    }
    if (Array.isArray(cur)) {
        const i = Number(last);
        if (!Number.isInteger(i)) throw new Error(`expected array index, got "${last}"`);
        (cur as unknown[])[i] = value;
    } else {
        (cur as Record<string, unknown>)[last] = value;
    }
}

function parseValue(raw: string): unknown {
    try { return JSON.parse(raw); } catch { return raw; }
}

function prettyValue(v: unknown): string {
    if (typeof v === 'string') return `"${v}"`;
    return JSON.stringify(v);
}

function atomicWrite(file: string, value: unknown): void {
    const tmp = `${file}.tmp`;
    const body = JSON.stringify(value, null, 4) + '\n';
    writeFileSync(tmp, body, 'utf-8');
    renameSync(tmp, file);
}

/**
 * Invert the `mcp.servers.*.assignTo` push map so we can look up "which
 * MCPs land on this agent?" cheaply. Matches the resolution order in
 * `filterToolsForAgent`: an agent's explicit `mcpServers` list wins,
 * otherwise the agent gets every server whose `assignTo` includes
 * its name or the `*` wildcard.
 */
type PushMap = Readonly<Record<string, readonly string[]>>;

function buildPushMap(servers: Record<string, { assignTo?: readonly string[]; enabled?: boolean }>): PushMap {
    const byAgent: Record<string, string[]> = {};
    for (const [name, srv] of Object.entries(servers)) {
        if (srv.enabled === false) continue;
        const targets = srv.assignTo ?? [];
        for (const t of targets) {
            if (!byAgent[t]) byAgent[t] = [];
            byAgent[t].push(name);
        }
    }
    return byAgent;
}

/** Resolve the effective MCP list for an agent (pull + push fallback). */
function effectiveMcp(a: RawAgent, pushMap: PushMap): readonly string[] {
    if (a.mcpServers && a.mcpServers.length > 0) return a.mcpServers;
    const pushed = pushMap[a.name] ?? [];
    const broadcast = pushMap['*'] ?? [];
    return [...pushed, ...broadcast];
}

function renderList(
    agents: ReadonlyArray<RawAgent>,
    pushMap: PushMap,
    live: LiveAgentMap = new Map(),
): void {
    console.log(section('Team'));
    if (agents.length === 0) {
        console.log(row('roster', dim('no agents configured')));
        return;
    }
    // Multi-line per agent so we can surface fallbacks + routing tiers
    // without a 200-col-wide table. Header line carries the hot info
    // (status dot, name, type, role, domain); subsequent indented
    // lines add model / fallbacks / tiers. Keys are dim so the values
    // pop without extra colour.
    for (const a of agents) {
        const disabled = a.enabled === false;
        const liveState = live.get(a.name);
        const dot = disabled ? dim('○') : liveState?.state === 'busy' ? chalk.cyan('▶') : tint.team('●');
        const name = disabled ? dim(a.name) : tint.team(a.name);
        const activityTag = (() => {
            if (disabled) return dim('disabled');
            if (!liveState) return dim('');
            if (liveState.state === 'busy') {
                const task = liveState.currentTask ? `: ${truncate(liveState.currentTask, 40)}` : '';
                return chalk.cyan(`working${task}`);
            }
            return dim('idle');
        })();
        const meta = [a.type, a.role, a.domain]
            .filter(Boolean)
            .map((s) => dim(s as string))
            .join(dim(' · '));
        const metaWithLive = activityTag ? `${meta}  ${activityTag}` : meta;
        console.log(`  ${dot}  ${name}  ${metaWithLive}`);

        const bullet = dim('-');
        if (a.model) console.log(`    ${bullet} ${dim('model   ')} ${dim(a.model)}`);

        const fallbacks = (a.fallback_models ?? [])
            .map(fmtModel)
            .filter((s): s is string => !!s);
        if (fallbacks.length > 0) {
            const painted = fallbacks.map((f) => dim(f)).join(dim(' → '));
            console.log(`    ${bullet} ${dim('fallback')} ${painted}`);
        }

        const tiers = a.routing?.tiers;
        if (a.routing?.enabled !== false && tiers) {
            const bits: string[] = [];
            if (tiers.fast?.name) bits.push(`${dim('⚡')} ${dim(fmtModel(tiers.fast)!)}`);
            if (tiers.balanced?.name) bits.push(`${dim('⚖')} ${dim(fmtModel(tiers.balanced)!)}`);
            if (tiers.powerful?.name) bits.push(`${dim('⚙')} ${dim(fmtModel(tiers.powerful)!)}`);
            if (bits.length > 0) {
                console.log(`    ${bullet} ${dim('tiers   ')} ${bits.join('  ')}`);
            }
        }

        // Effective MCP set = explicit `mcpServers` pull-list OR the
        // servers whose `assignTo` pushes to this agent. Without the
        // push view, gimli/legolas/saruman look like they have zero
        // MCPs when they actually inherit gmail/obsidian/etc.
        const mcps = effectiveMcp(a, pushMap);
        if (mcps.length > 0) {
            const source = a.mcpServers?.length ? '(pull)' : '(assignTo)';
            console.log(
                `    ${bullet} ${dim('mcp     ')} ${dim(mcps.join(', '))} ${dim(source)}`,
            );
        }

        // Sandbox — only shown when opted in (most agents don't have it).
        if (a.sandbox?.enabled) {
            const ptc = a.sandbox.programmaticToolCalling ? ' · programmatic-tools' : '';
            console.log(
                `    ${bullet} ${dim('sandbox ')} ${dim(`${a.sandbox.backend ?? 'local'}/${a.sandbox.language ?? 'python'}${ptc}`)}`,
            );
        }
    }
}

function renderOne(a: RawAgent, pushMap: PushMap): void {
    const enabled = a.enabled !== false;
    const dot = enabled ? tint.team('●') : dim('○');
    const name = enabled ? tint.team(a.name) : dim(a.name);
    const state = enabled ? dim('enabled') : dim('disabled');
    console.log(section(`Agent: ${a.name}`, 'team'));
    console.log(`  ${dot} ${name}  ${state}`);

    // Identity
    console.log(detail('role', a.role ?? '(default)'));
    console.log(detail('type', a.type ?? '(default)'));
    if (a.domain) console.log(detail('domain', a.domain));
    if (a.cost_tier) console.log(detail('cost tier', a.cost_tier));

    // Model + its tuning params
    if (a.model) console.log(detail('model', a.model));
    const mc = a.model_config;
    if (mc && (mc.temperature !== undefined || mc.maxTokens !== undefined)) {
        const bits: string[] = [];
        if (mc.temperature !== undefined) bits.push(`temperature=${mc.temperature}`);
        if (mc.maxTokens !== undefined) bits.push(`maxTokens=${mc.maxTokens}`);
        console.log(detail('tuning', bits.join(' · ')));
    }

    // Fallback chain (primary → 1st → 2nd → …)
    const fallbacks = (a.fallback_models ?? [])
        .map(fmtModel)
        .filter((s): s is string => !!s);
    if (fallbacks.length > 0) {
        console.log(detail('fallbacks', fallbacks.join(' → ')));
    }

    // Routing tiers — fast / balanced / powerful
    const tiers = a.routing?.tiers;
    if (a.routing?.enabled !== false && tiers) {
        if (tiers.fast?.name) {
            console.log(detail('⚡ fast', fmtModel(tiers.fast) ?? ''));
        }
        if (tiers.balanced?.name) {
            console.log(detail('⚖ balanced', fmtModel(tiers.balanced) ?? ''));
        }
        if (tiers.powerful?.name) {
            console.log(detail('⚙ powerful', fmtModel(tiers.powerful) ?? ''));
        }
    }

    // Capabilities
    if (a.toolsets?.length) console.log(detail('toolsets', a.toolsets.join(', ')));
    if (a.workers?.length) console.log(detail('workers', a.workers.join(', ')));
    const mcps = effectiveMcp(a, pushMap);
    if (mcps.length > 0) {
        const label = a.mcpServers?.length ? 'mcp allow-list' : 'mcp (pushed)';
        console.log(detail(label, mcps.join(', ')));
    }
    if (a.approvals) {
        console.log(
            detail(
                'approvals',
                `tools=${(a.approvals.tools ?? []).join(', ') || '(none)'} · actions=${(a.approvals.actions ?? []).join(', ') || '(none)'}`,
            ),
        );
    }

    // Sandbox — the per-agent flopsygraph sandbox + programmatic tool
    // calling toggles. Rendered compactly on one line so it matches the
    // density of the rest of the detail view; flip to multi-line only
    // when the agent has non-default tuning.
    if (a.sandbox?.enabled) {
        const bits: string[] = [
            `${a.sandbox.backend ?? 'local'}/${a.sandbox.language ?? 'python'}`,
        ];
        if (a.sandbox.programmaticToolCalling) bits.push('programmatic-tools');
        if (a.sandbox.timeout) bits.push(`timeout=${a.sandbox.timeout}ms`);
        if (a.sandbox.memoryLimit) bits.push(`mem=${Math.round(a.sandbox.memoryLimit / 1024 / 1024)}MB`);
        if (a.sandbox.cpuLimit) bits.push(`cpu=${a.sandbox.cpuLimit}`);
        if (a.sandbox.networkEnabled) bits.push('network');
        console.log(detail('sandbox', bits.join(' · ')));
    } else {
        console.log(detail('sandbox', dim('disabled')));
    }
}
