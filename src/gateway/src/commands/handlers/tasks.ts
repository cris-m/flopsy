/**
 * `/tasks` slash command — in-flight and recent background tasks in the
 * current thread. The CLI `flopsy tasks` covers the cross-thread view.
 *
 * Scope intentionally mirrors /status: only this thread's activity, so the
 * command is useful in any channel without leaking other conversations'
 * state. Users who want system-wide visibility use the terminal CLI.
 */

import type { CommandDef, CommandContext, TaskSummary } from '../types';

export const tasksCommand: CommandDef = {
    name: 'tasks',
    aliases: ['task', 'work'],
    description: 'Show active + recent background tasks in this thread.',
    handler: async (ctx: CommandContext) => {
        const ts = ctx.threadStatus;
        if (!ts) {
            return {
                text:
                    '*Tasks*\n_no agent instantiated here yet — send a message first._',
            };
        }
        return { text: renderTasks(ts.activeTasks, ts.recentTasks) };
    },
};

function renderTasks(
    active: readonly TaskSummary[],
    recent: readonly TaskSummary[],
): string {
    if (active.length === 0 && recent.length === 0) {
        return '*Tasks*\n_idle — nothing in flight, nothing recent._';
    }

    const now = Date.now();
    const lines: string[] = [];
    lines.push(`*Tasks* — ${active.length} active · ${recent.length} recent`);

    if (active.length > 0) {
        lines.push('');
        lines.push('_active:_');
        for (const t of active) {
            const icon = activeIcon(t.status);
            const age = humanDuration(now - t.startedAtMs);
            lines.push(
                `${icon} \`${t.id}\` ${t.worker} — ${truncate(t.description, 60)} (${age})`,
            );
        }
    }

    if (recent.length > 0) {
        lines.push('');
        lines.push('_recent:_');
        for (const t of recent) {
            const icon = doneIcon(t.status);
            const age = t.endedAtMs !== undefined ? agoLabel(now - t.endedAtMs) : '?';
            const errBit = t.error ? ` — ${truncate(t.error, 50)}` : '';
            lines.push(
                `${icon} \`${t.id}\` ${t.worker} — ${truncate(t.description, 50)} (${t.status} ${age})${errBit}`,
            );
        }
    }

    return lines.join('\n');
}

function activeIcon(status: TaskSummary['status']): string {
    switch (status) {
        case 'running': return '▶️';
        case 'idle': return '⏸️';
        case 'pending': return '⏳';
        default: return '•';
    }
}

function doneIcon(status: TaskSummary['status']): string {
    switch (status) {
        case 'completed': return '✅';
        case 'failed': return '❌';
        case 'killed': return '🛑';
        default: return '•';
    }
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
