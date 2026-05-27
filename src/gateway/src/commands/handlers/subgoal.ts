import type { CommandDef, CommandContext, CommandResult } from '../types';
import { getGoalFacade } from '../goal-facade';
import { panel, row, STATE } from '@flopsy/shared';

export const subgoalCommand: CommandDef = {
    name: 'subgoal',
    description:
        'Layer extra criteria on the active /goal. `/subgoal <text>` to add, `/subgoal` to list, `/subgoal remove <N>`, `/subgoal clear`.',
    handler: async (ctx: CommandContext): Promise<CommandResult | null> => {
        const facade = getGoalFacade();
        if (!facade) {
            return { text: oneLine('subgoal', `${STATE.warn}  goal loop unavailable — extractor model not configured`) };
        }

        const active = facade.get(ctx.threadId);
        if (!active) {
            return { text: oneLine('subgoal', `${STATE.warn}  no active goal — use /goal <text> first`) };
        }

        const trimmed = ctx.rawArgs.trim();
        const first = ctx.args[0]?.toLowerCase() ?? '';

        if (trimmed === '' || first === 'list') {
            return { text: renderList(facade.renderSubgoals(ctx.threadId), active.goal) };
        }

        if (first === 'clear') {
            try {
                const n = facade.clearSubgoals(ctx.threadId);
                return {
                    text: n > 0
                        ? oneLine('subgoal', `${STATE.ok}  cleared ${n} subgoal${n === 1 ? '' : 's'}`)
                        : oneLine('subgoal', `${STATE.off}  nothing to clear`),
                };
            } catch (err) {
                return { text: oneLine('subgoal', `${STATE.warn}  ${(err as Error).message}`) };
            }
        }

        if (first === 'remove' || first === 'rm') {
            const idxStr = ctx.args[1];
            const idx = Number.parseInt(idxStr ?? '', 10);
            if (!Number.isFinite(idx)) {
                return { text: oneLine('subgoal', `${STATE.warn}  usage: /subgoal remove <N> (1-based)`) };
            }
            try {
                const { removed, remaining } = facade.removeSubgoal(ctx.threadId, idx);
                return {
                    text: oneLine(
                        'subgoal',
                        `${STATE.ok}  removed: ${truncate(removed, 80)}  ·  ${remaining} remaining`,
                    ),
                };
            } catch (err) {
                return { text: oneLine('subgoal', `${STATE.warn}  ${(err as Error).message}`) };
            }
        }

        const text = trimmed;
        try {
            const updated = facade.addSubgoal(ctx.threadId, text);
            return {
                text: panel(
                    [
                        {
                            title: 'subgoal',
                            lines: [
                                row('status', `${STATE.ok}  added`, 14),
                                row('count', `${updated.subgoals.length} subgoal${updated.subgoals.length === 1 ? '' : 's'} total`, 14),
                                row('latest', truncate(text, 120), 14),
                            ],
                        },
                    ],
                    { header: 'SUBGOAL ADDED' },
                ),
            };
        } catch (err) {
            return { text: oneLine('subgoal', `${STATE.warn}  ${(err as Error).message}`) };
        }
    },
};

function renderList(rendered: string, goal: string): string {
    return panel(
        [
            {
                title: 'subgoals',
                lines: [
                    row('goal', truncate(goal, 160), 14),
                    row('list', rendered, 14),
                ],
            },
        ],
        { header: 'SUBGOAL LIST' },
    );
}

function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function oneLine(title: string, value: string): string {
    return panel([{ title: '', lines: [row(title.toLowerCase(), value, 8)] }]);
}
