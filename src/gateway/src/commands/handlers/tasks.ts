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
        return { text: render(ts.activeTasks, ts.recentTasks) };
    },
};

function render(active: readonly TaskSummary[], recent: readonly TaskSummary[]): string {
    if (active.length === 0 && recent.length === 0) {
        return panel(
            [{ title: 'tasks', lines: [row('', 'idle — nothing in flight, nothing recent')] }],
            { header: 'TASKS' },
        );
    }

    const summary = `TASKS · ${active.length} active · ${recent.length} recent`;
    const sections: PanelSection[] = [];

    if (active.length > 0) {
        sections.push({ title: 'active', lines: active.map(activeRow) });
    }
    if (recent.length > 0) {
        sections.push({ title: 'recent', lines: recent.map(recentRow) });
    }

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
