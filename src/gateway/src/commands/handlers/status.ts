import { panel, row, STATE, agoLabel, truncate, formatCount } from '@flopsy/shared';
import type {
    CommandDef,
    CommandContext,
    GatewayStatusSnapshot,
    ThreadStatus,
} from '../types';
import type { PanelSection } from '@flopsy/shared';

export const statusCommand: CommandDef = {
    name: 'status',
    aliases: ['s'],
    description: 'Show gateway + team status.',
    handler: async (ctx: CommandContext) => {
        return { text: render(ctx) };
    },
};

function render(ctx: CommandContext): string {
    const g = ctx.gatewayStatus;
    const t = ctx.threadStatus;
    const sections: PanelSection[] = [];

    sections.push(buildGatewaySection(g));
    sections.push(buildChannelsSection(g));
    if (t?.team && t.team.length > 0) sections.push(buildTeamSection(t));
    if (g?.proactive) sections.push(buildProactiveSection(g));
    if (t) sections.push(buildThreadSection(t));

    const summary = buildSummary(g, t);
    return panel(sections, summary ? { header: summary } : {});
}

function buildSummary(g?: GatewayStatusSnapshot, t?: ThreadStatus): string {
    const parts: string[] = ['STATUS'];
    if (g?.uptimeMs !== undefined) {
        parts.push(`up ${agoLabel(g.uptimeMs).replace(' ago', '')}`);
    }
    if (t?.entryAgent) parts.push(t.entryAgent);
    return parts.join(' · ');
}

function buildGatewaySection(g?: GatewayStatusSnapshot): PanelSection {
    if (!g) return { title: 'gateway', lines: [row('status', `${STATE.fail} not running`)] };
    const lines: string[] = [];
    lines.push(row('status', `${STATE.ok} running`));
    if (g.uptimeMs !== undefined) lines.push(row('uptime', agoLabel(g.uptimeMs).replace(' ago', '')));
    if (g.activeThreads !== undefined && g.activeThreads > 0) {
        lines.push(row('active turns', String(g.activeThreads)));
    }
    if (g.version) lines.push(row('version', g.version));
    return { title: 'gateway', lines };
}

function buildChannelsSection(g?: GatewayStatusSnapshot): PanelSection {
    const channels = g?.channels ?? [];
    if (channels.length === 0) {
        return { title: 'channels', lines: [row('', '(none configured)')] };
    }
    const lines = channels.map((c) => {
        const glyph = !c.enabled
            ? STATE.off
            : c.status === 'connected'
                ? STATE.ok
                : c.status === 'error'
                    ? STATE.fail
                    : STATE.warn;
        const note = !c.enabled ? 'disabled' : c.status ?? 'unknown';
        return row(c.name, `${glyph}  ${note}`);
    });
    return { title: 'channels', lines };
}

function buildTeamSection(t: ThreadStatus): PanelSection {
    const team = t.team ?? [];
    const lines: string[] = [];
    const now = Date.now();
    for (const m of team) {
        let value: string;
        if (!m.enabled) {
            value = `${STATE.off}  disabled`;
        } else if (m.status === 'running' && m.currentTask) {
            value = `${STATE.on}  working · "${truncate(m.currentTask.description, 36)}"`;
        } else if (m.status === 'running') {
            value = `${STATE.on}  working`;
        } else {
            const ago =
                m.lastActiveAt !== undefined
                    ? ` · last ${agoLabel(now - m.lastActiveAt)}`
                    : '';
            value = `${STATE.off}  idle${ago}`;
        }
        lines.push(row(m.name, value));
    }
    return { title: `team  (${t.entryAgent ?? '?'})`, lines };
}

function buildProactiveSection(g: GatewayStatusSnapshot): PanelSection {
    const p = g.proactive!;
    const lines: string[] = [];
    if (p.heartbeats !== undefined && p.heartbeats > 0) {
        const last = p.lastHeartbeatAt ? ` · last ${agoLabel(Date.now() - p.lastHeartbeatAt)}` : '';
        lines.push(row('heartbeats', `${p.heartbeats} active${last}`));
    }
    if (p.cronJobs !== undefined && p.cronJobs > 0) {
        lines.push(row('cron jobs', String(p.cronJobs)));
    }
    if (p.inboundWebhooks !== undefined && p.inboundWebhooks > 0) {
        lines.push(row('webhooks', String(p.inboundWebhooks)));
    }
    const stats24h = (p as { stats24h?: { delivered: number; suppressed: number; errors: number } }).stats24h;
    if (stats24h) {
        const parts = [
            `${stats24h.delivered} delivered`,
            `${stats24h.suppressed} suppressed`,
            `${stats24h.errors} error${stats24h.errors === 1 ? '' : 's'}`,
        ];
        lines.push(row('24h', parts.join(' · ')));
    }
    if (lines.length === 0) {
        lines.push(row('', '(no schedules)'));
    }
    return { title: 'proactive', lines };
}

function buildThreadSection(t: ThreadStatus): PanelSection {
    const lines: string[] = [];
    if (t.tokens && t.tokens.calls > 0) {
        const k = t.tokens;
        lines.push(
            row('tokens today', `${formatCount(k.input)} in · ${formatCount(k.output)} out · ${k.calls} call${k.calls === 1 ? '' : 's'}`),
        );
    }
    if (t.activeTasks.length > 0) {
        lines.push(row('active', `${t.activeTasks.length} task${t.activeTasks.length === 1 ? '' : 's'}`));
        for (const a of t.activeTasks.slice(0, 3)) {
            const age = agoLabel(Date.now() - a.startedAtMs).replace(' ago', '');
            lines.push(row(`  ${a.worker}`, `"${truncate(a.description, 40)}" · ${age}`));
        }
    }
    if (t.recentTasks.length > 0 && t.activeTasks.length === 0) {
        const r = t.recentTasks[0]!;
        const age = r.endedAtMs !== undefined ? agoLabel(Date.now() - r.endedAtMs) : '?';
        lines.push(row('last task', `${r.worker} · ${r.status} · ${age}`));
    }
    if (lines.length === 0) {
        lines.push(row('', 'idle'));
    }
    return { title: 'this thread', lines };
}
