/**
 * `flopsy team` — inspect the agent roster from flopsy.json5.
 *
 * Read-only. For LIVE per-thread state (who's running a task right now),
 * use `/status` in a chat (the gateway exposes it there).
 */

import { Command } from 'commander';
import { bad, detail, dim, row, section } from '../ui/pretty';
import { readFlopsyConfig, type ModelRef, type RawAgent } from './config-reader';
import { tint } from '../ui/theme';

/** Format a ModelRef back into a "provider:name" string for display. */
function fmtModel(m: ModelRef | undefined): string | undefined {
    if (!m?.name) return undefined;
    return m.provider ? `${m.provider}:${m.name}` : m.name;
}

export function registerTeamCommands(root: Command): void {
    const team = root.command('team').description('Inspect the configured agent team');

    team.command('list')
        .description('Show every configured agent + role + enabled state')
        .action(() => {
            const { config } = readFlopsyConfig();
            renderList(config.agents ?? [], buildPushMap(config.mcp?.servers ?? {}));
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

    // Default: `flopsy team` with no subcommand → list.
    team.action(() => {
        const { config } = readFlopsyConfig();
        renderList(config.agents ?? [], buildPushMap(config.mcp?.servers ?? {}));
    });
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

function renderList(agents: ReadonlyArray<RawAgent>, pushMap: PushMap): void {
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
        const dot = disabled ? dim('○') : tint.team('●');
        const name = disabled ? dim(a.name) : tint.team(a.name);
        const meta = [a.type, a.role, a.domain]
            .filter(Boolean)
            .map((s) => dim(s as string))
            .join(dim(' · '));
        console.log(`  ${dot}  ${name}  ${meta}`);

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
}
