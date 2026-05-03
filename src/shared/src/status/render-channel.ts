/**
 * Channel renderers — `/status` output for chat adapters. Two flavours:
 *   - Markdown: Telegram, Discord, Slack, Mattermost (supports *bold*, _italic_,
 *     inline code, line breaks)
 *   - Plain: Signal, SMS, email fallback (no formatting)
 *
 * Neither renderer references ANSI colour, terminal width, or filesystem paths.
 * Output is intended to fit in a single chat message — aim for <1500 chars.
 */

import type { StatusSnapshot } from './types';
import { EMOJI, agoLabel, truncate } from './format';

/** Markdown-flavoured status — safe for Telegram/Discord/Slack. */
export function renderChannelMarkdown(s: StatusSnapshot): string {
    const lines: string[] = [];

    // Issues surface first when present — operator sees the problem before stats.
    if (s.issues && s.issues.length > 0) {
        lines.push(s.issues.map((i) => `${i.severity === 'error' ? '❌' : '⚠️'} ${i.message}`).join('\n'));
        lines.push('');
    }

    {
        const parts: string[] = [];
        parts.push(s.gateway.running ? `${EMOJI.run} running` : `${EMOJI.stop} stopped`);
        if (s.gateway.uptimeMs !== undefined) parts.push(`up ${agoLabel(s.gateway.uptimeMs).replace(' ago', '')}`);
        if (s.gateway.activeThreads !== undefined && s.gateway.activeThreads > 0) {
            parts.push(`${s.gateway.activeThreads} turn${s.gateway.activeThreads === 1 ? '' : 's'}`);
        }
        lines.push(`*Gateway* ${parts.join(' · ')}`);
    }

    {
        const enabled = s.channels.filter((c) => c.enabled);
        const disabled = s.channels.filter((c) => !c.enabled);
        const total = s.channels.length;
        lines.push('');
        lines.push(`*Channels* ${enabled.length}/${total} enabled`);
        if (enabled.length > 0) {
            lines.push(enabled.map((c) => `${channelEmoji(c.status)} ${c.name}`).join(' · '));
        }
        if (disabled.length > 0) {
            lines.push(disabled.map((c) => `${EMOJI.off} ${c.name}`).join(' · '));
        }
    }

    if (s.team.length > 0) {
        const enabled = s.team.filter((m) => m.enabled);
        const working = enabled.filter((m) => m.status === 'working');
        const idle = enabled.filter((m) => m.status === 'idle');
        lines.push('');
        lines.push(`*Team* ${enabled.length}/${s.team.length} — ${working.length} working, ${idle.length} idle`);
        for (const m of working) {
            const task = m.currentTask ? ` ${truncate(m.currentTask, 40)}` : '';
            lines.push(`${EMOJI.working} \`${m.name}\` working${task}`);
        }
        if (idle.length > 0) {
            lines.push(`${EMOJI.idle} idle: ${idle.map((m) => m.name).join(', ')}`);
        }
    }

    {
        const p = s.proactive;
        lines.push('');
        if (!p.enabled) {
            lines.push(`*Proactive* ${EMOJI.off} disabled`);
        } else {
            const running = p.running === false ? EMOJI.stop : EMOJI.run;
            const triggerBits: string[] = [];
            if (p.heartbeats.count > 0) triggerBits.push(`${p.heartbeats.enabled} hb`);
            if (p.cron.count > 0) triggerBits.push(`${p.cron.enabled} cron`);
            if (p.webhooks.count > 0) triggerBits.push(`${p.webhooks.count} webhook${p.webhooks.count === 1 ? '' : 's'}`);
            const triggersLine = triggerBits.length > 0 ? triggerBits.join(' · ') : 'no schedules';
            lines.push(`*Proactive* ${running} ${triggersLine}`);

            // Last fire per kind (only when we have a timestamp)
            const fires: string[] = [];
            if (p.heartbeats.lastFireAgoMs !== undefined) fires.push(`hb ${agoLabel(p.heartbeats.lastFireAgoMs)}`);
            if (p.cron.lastFireAgoMs !== undefined) fires.push(`cron ${agoLabel(p.cron.lastFireAgoMs)}`);
            if (p.webhooks.lastReceiveAgoMs !== undefined) fires.push(`wh ${agoLabel(p.webhooks.lastReceiveAgoMs)}`);
            if (fires.length > 0) lines.push(`last fire — ${fires.join(' · ')}`);

            // 24h funnel
            if (p.stats24h) {
                const st = p.stats24h;
                const parts = [
                    `↓ ${st.delivered} delivered`,
                    `✕ ${st.suppressed} suppressed`,
                    `! ${st.errors} error${st.errors === 1 ? '' : 's'}`,
                ];
                if (st.retryPending > 0) parts.push(`q ${st.retryPending} pending`);
                lines.push(`24h: ${parts.join(' · ')}`);
                if (st.suppressedBreakdown && st.suppressed > 0) {
                    const bits: string[] = [];
                    if (st.suppressedBreakdown.dedup) bits.push(`${st.suppressedBreakdown.dedup} dedup`);
                    if (st.suppressedBreakdown.presence) bits.push(`${st.suppressedBreakdown.presence} presence`);
                    if (st.suppressedBreakdown.conditional) bits.push(`${st.suppressedBreakdown.conditional} conditional`);
                    if (bits.length > 0) lines.push(`suppressed by: ${bits.join(' · ')}`);
                }
            }
        }
    }

    // Integrations: skip when nothing interesting is set — slash /status in
    // chat cares less about this than the CLI does. Shown only when auth OR
    // MCP servers are configured.
    {
        const i = s.integrations;
        const hasContent = i.auth.length > 0 || i.mcp.configured > 0;
        if (hasContent) {
            const integ: string[] = [];
            if (i.auth.length > 0) {
                const ok = i.auth.filter((a) => !a.expired).length;
                const expired = i.auth.length - ok;
                const authTag = expired > 0 ? `${ok}/${i.auth.length} (${expired} expired)` : `${ok}/${i.auth.length}`;
                integ.push(`auth ${authTag}`);
            }
            if (i.mcp.configured > 0) integ.push(`mcp ${i.mcp.active}/${i.mcp.configured}`);
            if (i.memory.enabled) {
                integ.push(`memory ✓${i.memory.embedder ? ` ${i.memory.embedder}` : ''}`);
            }
            if (integ.length > 0) {
                lines.push('');
                lines.push(`*Integrations* ${integ.join(' · ')}`);
            }
        }
    }

    // Current thread — slash-only context.
    if (s.thread) {
        const t = s.thread;
        lines.push('');
        const headerParts: string[] = [`\`${t.entryAgent}\``];
        if (t.tokensToday) {
            const k = t.tokensToday;
            headerParts.push(`today: ${fmt(k.input)} in · ${fmt(k.output)} out · ${k.calls} call${k.calls === 1 ? '' : 's'}`);
        }
        lines.push(`*This channel* ${headerParts.join(' · ')}`);

        if (t.activeTasks && t.activeTasks.length > 0) {
            lines.push('_active:_');
            for (const a of t.activeTasks) {
                lines.push(`• \`${a.id}\` ${a.worker} — ${truncate(a.description, 60)} (${agoLabel(a.runningMs).replace(' ago', '')})`);
            }
        }
        if (t.recentTasks && t.recentTasks.length > 0) {
            lines.push('_recent:_');
            for (const r of t.recentTasks) {
                const age = r.endedAgoMs !== undefined ? agoLabel(r.endedAgoMs) : '?';
                lines.push(`• \`${r.id}\` ${r.worker} — ${truncate(r.description, 60)} (${r.status} ${age})`);
            }
        }
    }

    return lines.join('\n');
}

/** No-markdown fallback for Signal/SMS. Strips bold, cuts aggressively. */
export function renderChannelPlain(s: StatusSnapshot): string {
    // Strip markdown markers by rendering markdown then removing them.
    return renderChannelMarkdown(s)
        .replace(/[*_`]/g, '')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .join('\n');
}

function channelEmoji(status?: StatusSnapshot['channels'][number]['status']): string {
    switch (status) {
        case 'connected': return EMOJI.run;
        case 'connecting': return EMOJI.warn;
        case 'error': return EMOJI.no;
        case 'disconnected': return EMOJI.off;
        case 'disabled': return EMOJI.off;
        default: return EMOJI.run;
    }
}

function fmt(n: number): string {
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
