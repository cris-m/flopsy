import { panel, row, STATE, agoLabel, truncate } from '@flopsy/shared';
import type { CommandDef, CommandContext, TaskSummary } from '../types';
import type { PanelSection } from '@flopsy/shared';

export const tasksCommand: CommandDef = {
    name: 'tasks',
    aliases: ['task', 'work'],
    description: 'Show active + recent background tasks in this thread.',
    handler: async (ctx: CommandContext) => {
        const ts = ctx.threadStatus;
        if (!ts) {
            return {
                text: panel(
                    [{ title: 'tasks', lines: [row('', 'no agent instantiated here yet — send a message first')] }],
                    { header: 'TASKS' },
                ),
            };
        }
        return {
            text: render(ts.activeTasks, ts.recentTasks, {
                agentActive: ts.agentActive === true,
                ...(ts.agentTurnStartedAt !== undefined ? { startedAtMs: ts.agentTurnStartedAt } : {}),
                entryAgent: ts.entryAgent,
            }),
        };
    },
};

interface MainTurn {
    readonly agentActive: boolean;
    readonly startedAtMs?: number;
    readonly entryAgent: string;
}

function render(
    active: readonly TaskSummary[],
    recent: readonly TaskSummary[],
    main: MainTurn,
): string {
    if (active.length === 0 && recent.length === 0 && !main.agentActive) {
        return panel(
            [{ title: 'tasks', lines: [row('', 'idle — nothing in flight, nothing recent')] }],
            { header: 'TASKS' },
        );
    }

    const sections: PanelSection[] = [];

    if (main.agentActive) {
        const age = main.startedAtMs !== undefined
            ? agoLabel(Date.now() - main.startedAtMs).replace(' ago', '')
            : 'now';
        sections.push({
            title: 'in progress',
            lines: [row(`${STATE.on}  ${main.entryAgent}`, `processing your message · ${age}`, 18)],
        });
    }
    if (active.length > 0) {
        sections.push({ title: 'active', lines: active.map(activeRow) });
    }
    if (recent.length > 0) {
        sections.push({ title: 'recent', lines: recent.map(recentRow) });
    }

    const parts: string[] = [];
    if (main.agentActive) parts.push('agent working');
    if (active.length > 0) parts.push(`${active.length} active`);
    if (recent.length > 0) parts.push(`${recent.length} recent`);
    const summary = `TASKS · ${parts.join(' · ')}`;

    return panel(sections, { header: summary });
}

function activeRow(t: TaskSummary): string {
    const glyph = t.status === 'running' ? STATE.on : STATE.bullet;
    const age = agoLabel(Date.now() - t.startedAtMs).replace(' ago', '');
    const desc = truncate(t.description, 40);
    return row(`${glyph}  ${t.worker}`, `"${desc}" · ${age}`, 18);
}

function recentRow(t: TaskSummary): string {
    const glyph =
        t.status === 'completed' ? STATE.ok :
        t.status === 'failed'    ? STATE.fail :
        t.status === 'killed'    ? STATE.fail :
        STATE.bullet;
    const age = t.endedAtMs !== undefined ? agoLabel(Date.now() - t.endedAtMs) : '?';
    const desc = truncate(t.description, 36);
    const errBit = t.error ? ` · ${truncate(t.error, 30)}` : '';
    return row(`${glyph}  ${t.worker}`, `"${desc}" · ${t.status} · ${age}${errBit}`, 18);
}
