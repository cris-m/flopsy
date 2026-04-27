/**
 * `/team` slash command — show the configured agents and what each is
 * doing right now. Scoped to the current thread (the one the command
 * was sent from); the CLI `flopsy team` covers config-level inspection.
 */

import type { CommandDef, CommandContext, TeamMemberSummary } from '../types';

export const teamCommand: CommandDef = {
    name: 'team',
    aliases: ['t', 'roster'],
    description: 'Show the team roster and what each worker is doing.',
    handler: async (ctx: CommandContext) => {
        const team = ctx.threadStatus?.team;
        if (!team || team.length === 0) {
            return {
                text:
                    '*Team*\n_no team configured here yet — send a message first or check `flopsy team` on the server._',
            };
        }
        return { text: renderTeam(ctx.threadStatus?.entryAgent, team) };
    },
};

function renderTeam(entryAgent: string | undefined, team: readonly TeamMemberSummary[]): string {
    const enabled = team.filter((m) => m.enabled);
    const working = enabled.filter((m) => m.status === 'running');
    const idle = enabled.filter((m) => m.status === 'idle');
    const disabled = team.filter((m) => !m.enabled);

    const lines: string[] = [];
    const header = entryAgent ? `*Team* — leader \`${entryAgent}\`` : '*Team*';
    lines.push(`${header} · ${enabled.length}/${team.length} enabled · ${working.length} working, ${idle.length} idle`);

    // Per-agent block — mirrors `flopsy team show` on the CLI so the chat
    // user gets the same visibility (role, domain, model, toolsets, mcp
    // servers, sandbox) without needing shell access. Kept compact: one
    // markdown bullet line per fact, only the facts that are set.
    for (const m of enabled) {
        const icon = m.status === 'running' ? '🔵' : '💤';
        const taskBit =
            m.status === 'running' && m.currentTask
                ? ` — "${truncate(m.currentTask.description, 60)}" (${humanDuration(m.currentTask.runningMs)})`
                : '';
        const idleBit =
            m.status === 'idle' && m.lastActiveAt !== undefined
                ? ` · last active ${agoLabel(Date.now() - m.lastActiveAt)}`
                : '';
        lines.push('');
        lines.push(`${icon} \`${m.name}\` (${m.type})${taskBit}${idleBit}`);
        const meta: string[] = [];
        if (m.role) meta.push(`role=${m.role}`);
        if (m.domain) meta.push(`domain=${m.domain}`);
        if (m.model) meta.push(`model=\`${m.model}\``);
        if (meta.length > 0) lines.push(`   ${meta.join(' · ')}`);
        if (m.toolsets && m.toolsets.length > 0) {
            lines.push(`   toolsets: ${m.toolsets.join(', ')}`);
        }
        if (m.mcpServers && m.mcpServers.length > 0) {
            lines.push(`   mcp: ${m.mcpServers.join(', ')}`);
        }
        if (m.sandbox?.enabled) {
            const sb = m.sandbox;
            const ptc = sb.programmaticToolCalling ? ' · programmatic-tools' : '';
            lines.push(`   sandbox: ${sb.backend ?? 'local'}/${sb.language ?? 'python'}${ptc}`);
        }
    }

    if (disabled.length > 0) {
        lines.push('');
        lines.push(`⚪ disabled: ${disabled.map((m) => m.name).join(', ')}`);
    }

    return lines.join('\n');
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

function humanDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

function agoLabel(ms: number): string {
    if (ms < 60_000) return 'just now';
    const m = Math.floor(ms / 60_000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}
