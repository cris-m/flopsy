/**
 * /status — what the system and the team are doing right now.
 *
 * Two sections, in order:
 *   1. Gateway — uptime + per-channel connection status + active-thread count.
 *      Populated from a snapshot closure injected at router construction.
 *   2. This thread — active + recent tasks from AgentHandler.queryStatus.
 *
 * Privacy: the gateway snapshot only carries channel names, status flags, and
 * counts. No tokens, no peer ids, no guild/channel ids.
 */

import type { CommandDef, CommandContext, TaskSummary, GatewayStatusSnapshot } from '../types';

export const statusCommand: CommandDef = {
    name: 'status',
    aliases: ['s'],
    description: 'Show gateway + team status.',
    handler: async (ctx: CommandContext) => {
        const sections: string[] = [];

        if (ctx.gatewayStatus) {
            sections.push(renderGateway(ctx.gatewayStatus));
        }

        sections.push(renderThread(ctx));

        return { text: sections.join('\n\n') };
    },
};

function renderGateway(g: GatewayStatusSnapshot): string {
    const header = [
        g.version ? `build ${g.version}` : null,
        `up ${humanDuration(g.uptimeMs)}`,
        g.port !== undefined ? `port ${g.port}` : null,
        `${g.activeThreads} thread${g.activeThreads === 1 ? '' : 's'}`,
    ]
        .filter((s): s is string => s !== null)
        .join(' · ');

    const lines: string[] = [`*Gateway* — ${header}`];
    if (g.channels.length === 0) {
        lines.push('  _no channels registered_');
    } else {
        for (const ch of g.channels) {
            const icon = channelIcon(ch.status, ch.enabled);
            lines.push(`  ${icon} ${ch.name} — ${ch.enabled ? ch.status : 'disabled'}`);
        }
    }

    if (g.webhook) {
        const wh = g.webhook;
        if (wh.enabled) {
            const portPart = wh.port !== undefined ? ` on :${wh.port}` : '';
            lines.push(`  🪝 webhook${portPart} — ${wh.routeCount} route${wh.routeCount === 1 ? '' : 's'}`);
        } else {
            lines.push(`  🪝 webhook — off`);
        }
    }

    if (g.proactive) {
        const p = g.proactive;
        const parts: string[] = [];
        if (p.heartbeats > 0) parts.push(`${p.heartbeats} heartbeat${p.heartbeats === 1 ? '' : 's'}`);
        if (p.cronJobs > 0) parts.push(`${p.cronJobs} cron`);
        if (p.inboundWebhooks > 0) parts.push(`${p.inboundWebhooks} inbound`);
        if (p.lastHeartbeatAt) {
            parts.push(`last fire ${humanDuration(Date.now() - p.lastHeartbeatAt)} ago`);
        }
        const tail = parts.length > 0 ? ` · ${parts.join(', ')}` : '';
        const icon = p.running ? '⏰' : '⏸️';
        const state = p.running ? 'running' : 'stopped';
        lines.push(`  ${icon} proactive — ${state}${tail}`);
    }

    return lines.join('\n');
}

function renderThread(ctx: CommandContext): string {
    const status = ctx.threadStatus;
    if (!status) {
        return "*This channel*\n  _no agent instantiated here yet — send a message first._";
    }
    const { activeTasks, recentTasks, entryAgent, tokens, team } = status;

    const headerParts: string[] = [`\`${entryAgent}\``];
    if (tokens) {
        headerParts.push(
            `today: ${formatCount(tokens.input)} in · ${formatCount(tokens.output)} out · ${tokens.calls} call${tokens.calls === 1 ? '' : 's'}`,
        );
    }
    const header = `*This channel* — ${headerParts.join(' · ')}`;

    const lines: string[] = [header];

    // Per-model breakdown (only when there's more than one model or a
    // meaningful single-model total — skip if it duplicates the header).
    if (tokens && tokens.byModel.length > 0) {
        const interesting = tokens.byModel.length > 1 || tokens.calls > 1;
        if (interesting) {
            lines.push('  *Models today:*');
            for (const m of tokens.byModel) {
                lines.push(
                    `    • \`${m.model}\` — ${formatCount(m.input)} in · ${formatCount(m.output)} out (${m.calls} call${m.calls === 1 ? '' : 's'})`,
                );
            }
        }
    }

    // Team roster — one line per worker. Shows idle / running / disabled
    // so the user can see who's available at a glance. Omitted if the agent
    // layer didn't populate it (legacy, tests).
    if (team && team.length > 0) {
        lines.push('  *Team:*');
        for (const m of team) {
            const icon = teamIcon(m.status);
            if (m.status === 'running' && m.currentTask) {
                lines.push(
                    `    ${icon} \`${m.name}\` (${m.type}) — "${m.currentTask.description}" (${humanDuration(m.currentTask.runningMs)})`,
                );
            } else if (m.status === 'disabled') {
                lines.push(`    ${icon} \`${m.name}\` (${m.type}) — disabled`);
            } else {
                const suffix =
                    m.lastActiveAt !== undefined
                        ? ` · last active ${humanDuration(Date.now() - m.lastActiveAt)} ago`
                        : '';
                lines.push(`    ${icon} \`${m.name}\` (${m.type}) — idle${suffix}`);
            }
        }
    }

    if (activeTasks.length === 0 && recentTasks.length === 0) {
        if (lines.length === 1) return `${header}\n  _idle — nothing in flight, nothing recent._`;
        return lines.join('\n');
    }

    if (activeTasks.length > 0) {
        lines.push('  *Active:*');
        for (const t of activeTasks) {
            lines.push(`    • \`${t.id}\` ${t.worker} — ${t.description} (${humanDuration(Date.now() - t.startedAtMs)})`);
        }
    }
    if (recentTasks.length > 0) {
        lines.push('  *Recent:*');
        for (const t of recentTasks) {
            const age = t.endedAtMs ? humanDuration(Date.now() - t.endedAtMs) : '?';
            const icon = taskIcon(t.status);
            lines.push(`    ${icon} \`${t.id}\` ${t.worker} — ${t.description} (${t.status} ${age} ago)`);
        }
    }
    return lines.join('\n');
}

/** 1234 → "1.2k", 1_500_000 → "1.5M", <1000 → bare int. */
function formatCount(n: number): string {
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function channelIcon(status: string, enabled: boolean): string {
    if (!enabled) return '⚪';
    switch (status) {
        case 'connected':    return '✅';
        case 'connecting':   return '🔄';
        case 'disconnected': return '⚫';
        case 'error':        return '❌';
        default:             return '❓';
    }
}

function taskIcon(status: TaskSummary['status']): string {
    switch (status) {
        case 'completed': return '✅';
        case 'failed':    return '❌';
        case 'killed':    return '🛑';
        case 'idle':      return '💤';
        default:          return '•';
    }
}

function teamIcon(status: 'idle' | 'running' | 'disabled'): string {
    switch (status) {
        case 'running':  return '▶️';
        case 'disabled': return '⚪';
        case 'idle':
        default:         return '💤';
    }
}

function humanDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return `${m}m ${rem}s`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h < 24) return `${h}h ${mm}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}
