/**
 * Terminal renderers — compact + verbose. Pure string builders; the caller
 * supplies colour functions so the shared package stays terminal-agnostic.
 */

import type { StatusSnapshot } from './types';
import { GLYPH, agoLabel, humanDuration, tildePath, truncate } from './format';

export interface CliTheme {
    ok(s: string): string;
    warn(s: string): string;
    bad(s: string): string;
    dim(s: string): string;
    accent(s: string): string;
    /** Bold / heading colour — used for `◆ Section` labels. */
    heading(s: string): string;
}

/** No-op theme — useful in tests and when --no-color is set. */
export const plainTheme: CliTheme = {
    ok: (s) => s,
    warn: (s) => s,
    bad: (s) => s,
    dim: (s) => s,
    accent: (s) => s,
    heading: (s) => s,
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visLen(s: string): number {
    return s.replace(ANSI_RE, '').length;
}

function padTo(s: string, n: number): string {
    const v = visLen(s);
    return v >= n ? s : s + ' '.repeat(n - v);
}

function boxTop(title: string, width: number, t: CliTheme): string {
    const titleStr = ` ${title} `;
    const fill = Math.max(1, width - visLen(titleStr) - 3);
    return t.dim('╭─') + t.heading(titleStr) + t.dim('─'.repeat(fill) + '╮');
}

function boxRow(content: string, width: number, t: CliTheme): string {
    const inner = width - 4;
    return t.dim('│ ') + ' ' + padTo(content, inner - 1) + t.dim(' │');
}

function boxBottom(width: number, t: CliTheme): string {
    return t.dim('╰' + '─'.repeat(width - 2) + '╯');
}

/** Compact render: one rounded box per section. Sized to caller-provided width. */
export function renderCliCompact(s: StatusSnapshot, t: CliTheme = plainTheme, width = 80): string {
    const W = Math.max(60, Math.min(width, 120));
    const lines: string[] = [];

    if (s.issues && s.issues.length > 0) {
        for (const i of s.issues) {
            const marker = i.severity === 'error' ? t.bad('✕') : t.warn('⚠');
            lines.push(`${marker} ${i.message}${i.hint ? t.dim(` — ${i.hint}`) : ''}`);
        }
    }

    const section = (title: string, rows: string[]): void => {
        lines.push(boxTop(title, W, t));
        for (const r of rows) lines.push(boxRow(r, W, t));
        lines.push(boxBottom(W, t));
    };

    {
        const parts: string[] = [];
        if (s.gateway.running) {
            parts.push(t.ok(`${GLYPH.dot} running`));
            parts.push(t.dim(`${s.gateway.host}:${s.gateway.port}`));
            if (s.gateway.pid !== undefined) parts.push(t.dim(`pid ${s.gateway.pid}`));
            if (s.gateway.uptimeMs !== undefined) parts.push(t.dim(`up ${humanDuration(s.gateway.uptimeMs)}`));
            if (s.gateway.activeThreads && s.gateway.activeThreads > 0) {
                parts.push(t.accent(`${s.gateway.activeThreads} turn${s.gateway.activeThreads === 1 ? '' : 's'}`));
            }
        } else {
            parts.push(t.bad(`${GLYPH.circle} not running`));
            parts.push(t.dim(`${s.gateway.host}:${s.gateway.port}`));
            parts.push(t.dim('run `flopsy gateway start`'));
        }
        section('Gateway', [parts.join('    ')]);
    }

    {
        const enabled = s.channels.filter((c) => c.enabled);
        const disabled = s.channels.filter((c) => !c.enabled);
        const total = s.channels.length;
        if (total === 0) {
            section('Channels', [t.dim('none configured')]);
        } else {
            const rows: string[] = [];
            if (enabled.length > 0) {
                rows.push(enabled.map((c) => `${t.ok(GLYPH.dot)} ${c.name}`).join('  '));
            }
            if (disabled.length > 0) {
                rows.push(disabled.map((c) => t.dim(`${GLYPH.circle} ${c.name}`)).join('  '));
            }
            section(`Channels (${enabled.length}/${total} active)`, rows);
        }
    }

    {
        if (s.team.length === 0) {
            section('Team', [t.dim('none configured')]);
        } else {
            const enabled = s.team.filter((m) => m.enabled);
            const summary = s.team.map((m) => {
                if (!m.enabled) return t.dim(m.name);
                if (m.status === 'working') return t.accent(`${m.name}*`);
                return m.name;
            });
            const rows: string[] = [summary.join('  ')];
            const working = s.team.filter((m) => m.status === 'working' && m.currentTask);
            if (working.length > 0) {
                rows.push(
                    t.dim(working.map((m) => `${m.name}: ${truncate(m.currentTask!, 30)}`).join(' · ')),
                );
            }
            section(`Team (${enabled.length}/${s.team.length} ready)`, rows);
        }
    }

    {
        const p = s.proactive;
        const parts: string[] = [];
        if (!p.enabled) {
            parts.push(t.dim(`${GLYPH.circle} disabled`));
        } else {
            parts.push(p.running === false ? t.warn(`${GLYPH.circle} stopped`) : t.ok(`${GLYPH.dot} running`));
            const triggers: string[] = [];
            if (p.heartbeats.count > 0) triggers.push(`${p.heartbeats.enabled} hb`);
            if (p.cron.count > 0) triggers.push(`${p.cron.enabled} cron`);
            if (p.webhooks.count > 0) triggers.push(`${p.webhooks.count} wh`);
            if (triggers.length === 0) triggers.push('no schedules');
            parts.push(t.dim(triggers.join(' · ')));
        }
        const rows: string[] = [parts.join('    ')];
        if (p.stats24h) {
            const st = p.stats24h;
            const funnel = [
                t.ok(`${GLYPH.delivered}${st.delivered}`),
                st.suppressed > 0 ? t.warn(`${GLYPH.suppressed}${st.suppressed}`) : t.dim(`${GLYPH.suppressed}0`),
                st.errors > 0 ? t.bad(`${GLYPH.error}${st.errors}`) : t.dim(`${GLYPH.error}0`),
            ];
            if (st.retryPending > 0) funnel.push(t.warn(`${GLYPH.queue}${st.retryPending}`));
            rows.push(`${t.dim('24h')}  ${funnel.join(' ')}`);
        }
        section('Proactive', rows);
    }

    if (s.integrations.vault) {
        const v = s.integrations.vault;
        const parts: string[] = [];
        if (!v.initialised) {
            parts.push(t.dim(`${GLYPH.circle} not initialised`));
            parts.push(t.dim('run `flopsy vault init`'));
        } else if (v.serverRunning) {
            parts.push(t.ok(`${GLYPH.dot} server running`));
            if (v.mgmtPort !== undefined && v.proxyPort !== undefined) {
                parts.push(t.dim(`mgmt :${v.mgmtPort}  proxy :${v.proxyPort}`));
            }
            const stats: string[] = [];
            if (v.secrets !== undefined) stats.push(`${v.secrets} secrets`);
            if (v.tokens !== undefined) stats.push(`${v.tokens} tokens`);
            if (v.rules !== undefined) stats.push(`${v.rules} rules`);
            if (stats.length > 0) parts.push(t.dim(stats.join('  ')));
        } else {
            parts.push(t.warn(`${GLYPH.circle} server stopped`));
            parts.push(t.dim('run `flopsy vault server`'));
        }
        section('Vault', [parts.join('    ')]);
    }

    {
        const i = s.integrations;
        const parts: string[] = [];
        if (i.auth.length === 0) {
            parts.push(t.dim('auth none'));
        } else {
            const ok = i.auth.filter((a) => !a.expired).length;
            const tag = `auth ${ok}/${i.auth.length}`;
            parts.push(ok < i.auth.length ? t.warn(tag) : t.ok(tag));
        }
        parts.push(i.mcp.enabled ? `${t.ok('mcp')} ${i.mcp.active}/${i.mcp.configured}` : t.dim('mcp off'));
        if (i.memory.enabled) {
            const emb = i.memory.embedder ? ` ${t.dim(i.memory.embedder)}` : '';
            parts.push(`${t.ok(`${GLYPH.dot} memory`)}${emb}`);
        } else {
            parts.push(t.dim('memory off'));
        }
        section('Integrations', [parts.join('    ')]);
    }

    if (s.work && (s.work.active.length > 0 || (s.work.recent?.length ?? 0) > 0)) {
        const parts: string[] = [];
        if (s.work.active.length > 0) {
            parts.push(t.accent(`${s.work.active.length} active`));
            const preview = s.work.active
                .slice(0, 2)
                .map((w) => `${w.worker}: ${truncate(w.description, 30)}`);
            parts.push(t.dim(preview.join(' · ')));
        }
        if (s.work.recent && s.work.recent.length > 0) {
            parts.push(t.dim(`${s.work.recent.length} recent`));
        }
        section('Work', [parts.join('    ')]);
    }

    section('Config', [t.dim(tildePath(s.paths.config))]);

    return lines.join('\n');
}

/** Verbose render: `◆ Heading` with indented rows. Used by `flopsy status --verbose`. */
export function renderCliVerbose(s: StatusSnapshot, t: CliTheme = plainTheme): string {
    const lines: string[] = [];
    const heading = (name: string) => t.heading(`${GLYPH.diamond} ${name}`);

    if (s.issues && s.issues.length > 0) {
        lines.push(heading('Attention'));
        for (const i of s.issues) {
            const marker = i.severity === 'error' ? t.bad('✕') : t.warn('⚠');
            lines.push(`  ${marker} ${i.message}`);
            if (i.hint) lines.push(`    ${t.dim(i.hint)}`);
        }
        lines.push('');
    }

    lines.push(heading('Gateway'));
    if (s.gateway.running) {
        lines.push(`  state        ${t.ok('running')}`);
        if (s.gateway.pid !== undefined) lines.push(`  pid          ${s.gateway.pid}`);
        if (s.gateway.uptimeMs !== undefined) lines.push(`  uptime       ${humanDuration(s.gateway.uptimeMs)}`);
        lines.push(`  address      ${s.gateway.host}:${s.gateway.port}`);
        if (s.gateway.version) lines.push(`  version      ${s.gateway.version}`);
        if (s.gateway.activeThreads && s.gateway.activeThreads > 0) {
            lines.push(`  active turns ${s.gateway.activeThreads}`);
        }
    } else {
        lines.push(`  state        ${t.bad('not running')}`);
        lines.push(`  address      ${s.gateway.host}:${s.gateway.port}`);
        lines.push(`  hint         ${t.dim('run `flopsy gateway start`')}`);
    }
    lines.push('');

    {
        const total = s.channels.length;
        const enabledCount = s.channels.filter((c) => c.enabled).length;
        lines.push(heading(`Channels (${enabledCount}/${total})`));
        if (total === 0) {
            lines.push(`  ${t.dim('none configured')}`);
        } else {
            for (const c of s.channels) {
                const dot = c.enabled ? t.ok(GLYPH.dot) : t.dim(GLYPH.circle);
                const statusTag = c.enabled ? (c.status ?? 'unknown') : 'disabled';
                lines.push(`  ${dot} ${c.name.padEnd(12)} ${t.dim(statusTag)}`);
            }
        }
        lines.push('');
    }

    {
        const total = s.team.length;
        const enabledCount = s.team.filter((m) => m.enabled).length;
        lines.push(heading(`Team (${enabledCount}/${total})`));
        if (total === 0) {
            lines.push(`  ${t.dim('none configured')}`);
        } else {
            for (const m of s.team) {
                const dot = m.enabled ? t.ok(GLYPH.dot) : t.dim(GLYPH.circle);
                let tag: string;
                if (!m.enabled) tag = t.dim('disabled');
                else if (m.status === 'working') {
                    tag = t.accent(`working${m.currentTask ? ': ' + truncate(m.currentTask, 40) : ''}`);
                } else {
                    const age = m.lastActiveAgoMs !== undefined ? ` · last ${agoLabel(m.lastActiveAgoMs)}` : '';
                    tag = t.dim(`idle${age}`);
                }
                lines.push(`  ${dot} ${m.name.padEnd(12)} ${tag}`);
            }
        }
        lines.push('');
    }

    {
        const p = s.proactive;
        lines.push(heading('Proactive'));
        if (!p.enabled) {
            lines.push(`  ${t.dim('disabled in flopsy.json5 (proactive.enabled = false)')}`);
        } else {
            lines.push(`  state        ${p.running === false ? t.warn('stopped') : t.ok('running')}`);
            lines.push(
                `  heartbeats   ${p.heartbeats.enabled}/${p.heartbeats.count} active${
                    p.heartbeats.lastFireAgoMs !== undefined ? t.dim(` · last ${agoLabel(p.heartbeats.lastFireAgoMs)}`) : ''
                }`,
            );
            lines.push(
                `  cron         ${p.cron.enabled}/${p.cron.count} active${
                    p.cron.lastFireAgoMs !== undefined ? t.dim(` · last ${agoLabel(p.cron.lastFireAgoMs)}`) : ''
                }`,
            );
            lines.push(
                `  webhooks     ${p.webhooks.count} route${p.webhooks.count === 1 ? '' : 's'}${
                    p.webhooks.lastReceiveAgoMs !== undefined ? t.dim(` · last ${agoLabel(p.webhooks.lastReceiveAgoMs)}`) : ''
                }`,
            );
            if (p.stats24h) {
                const st = p.stats24h;
                lines.push(
                    `  24h funnel   ${t.ok(`${st.delivered} delivered`)} · ${
                        st.suppressed > 0 ? t.warn(`${st.suppressed} suppressed`) : t.dim('0 suppressed')
                    } · ${st.errors > 0 ? t.bad(`${st.errors} error${st.errors === 1 ? '' : 's'}`) : t.dim('0 errors')}`,
                );
                if (st.retryPending > 0) {
                    lines.push(`  retry queue  ${t.warn(`${st.retryPending} pending`)}`);
                }
                if (st.suppressedBreakdown && st.suppressed > 0) {
                    const b = st.suppressedBreakdown;
                    const parts: string[] = [];
                    if (b.dedup) parts.push(`${b.dedup} dedup`);
                    if (b.presence) parts.push(`${b.presence} presence`);
                    if (b.conditional) parts.push(`${b.conditional} conditional`);
                    if (b.other) parts.push(`${b.other} other`);
                    if (parts.length > 0) lines.push(`  suppressed   ${t.dim(parts.join(' · '))}`);
                }
            }
        }
        lines.push('');
    }

    {
        const i = s.integrations;
        lines.push(heading('Integrations'));
        if (i.auth.length === 0) {
            lines.push(`  auth         ${t.dim('none · run `flopsy auth <provider>`')}`);
        } else {
            for (const a of i.auth) {
                const name = a.email ? `${a.provider} (${a.email})` : a.provider;
                const remaining = `${a.expiresInMinutes}m left`;
                const tag = a.expired
                    ? t.bad('expired')
                    : a.expiresInMinutes < 60
                      ? t.warn(remaining)
                      : t.ok(remaining);
                lines.push(`  auth         ${name.padEnd(24)} ${tag}`);
            }
        }
        lines.push(
            `  mcp          ${
                i.mcp.enabled ? t.ok(`${i.mcp.active}/${i.mcp.configured} servers enabled`) : t.bad('disabled')
            }`,
        );
        lines.push(
            `  memory       ${
                i.memory.enabled
                    ? t.ok('enabled') + t.dim(` · ${i.memory.embedder ?? 'no embedder'}`)
                    : t.bad('disabled')
            }`,
        );
        lines.push('');
    }

    lines.push(heading('Paths'));
    lines.push(`  config       ${tildePath(s.paths.config)}`);
    lines.push(`  state        ${tildePath(s.paths.state)}`);

    return lines.join('\n');
}
