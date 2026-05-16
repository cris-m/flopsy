import type { CommandDef, CommandContext, CommandResult } from '../types';
import { getGoalFacade } from '../goal-facade';
import { panel, row, STATE } from '@flopsy/shared';

const SUBCOMMANDS = new Set(['status', 'pause', 'resume', 'clear', 'stop', 'set']);

export const goalCommand: CommandDef = {
    name: 'goal',
    description:
        'Set a standing goal the agent works toward until done. `/goal <text>`, `/goal status|pause|resume|clear`.',
    handler: async (ctx: CommandContext): Promise<CommandResult | null> => {
        const facade = getGoalFacade();
        if (!facade) {
            return { text: oneLine('goal', `${STATE.warn}  goal loop unavailable — extractor model not configured`) };
        }

        const trimmed = ctx.rawArgs.trim();
        const first = ctx.args[0]?.toLowerCase() ?? '';

        if (trimmed === '' || first === 'status') {
            const row = facade.get(ctx.threadId);
            return { text: renderStatus(row) };
        }

        if (first === 'pause') {
            const updated = facade.pause(ctx.threadId);
            if (!updated) return { text: oneLine('goal', `${STATE.warn}  no active goal in this thread`) };
            return { text: oneLine('goal', `${STATE.ok}  paused · /goal resume to continue`) };
        }

        if (first === 'resume') {
            const updated = facade.resume(ctx.threadId);
            if (!updated) return { text: oneLine('goal', `${STATE.warn}  no goal in this thread to resume`) };
            return {
                text: oneLine('goal', `${STATE.ok}  resumed (turn counter reset) · ${updated.maxTurns} turns max`),
                forwardToAgent: agentBumpMessage(updated.goal),
            };
        }

        if (first === 'clear' || first === 'stop') {
            const cleared = facade.clear(ctx.threadId);
            return {
                text: cleared
                    ? oneLine('goal', `${STATE.ok}  cleared`)
                    : oneLine('goal', `${STATE.warn}  nothing to clear`),
            };
        }

        const goalText = first === 'set'
            ? trimmed.replace(/^set\s*/i, '').trim()
            : trimmed;

        if (!goalText) {
            return { text: oneLine('goal', `${STATE.warn}  give a goal · /goal <what you want>`) };
        }

        if (SUBCOMMANDS.has(goalText.toLowerCase().split(/\s+/)[0]!)) {
            return { text: oneLine('goal', `${STATE.warn}  reserved subcommand — quote or rephrase`) };
        }

        const peerId = ctx.peer.id;
        const created = facade.set({
            threadId: ctx.threadId,
            channelName: ctx.channelName,
            peerId,
            goal: goalText,
        });

        return {
            text: panel(
                [
                    {
                        title: 'goal',
                        lines: [
                            row('status', `${STATE.ok}  active`, 14),
                            row('budget', `${created.maxTurns} turns max`, 14),
                            row('goal', truncate(created.goal, 200), 14),
                        ],
                    },
                ],
                { header: 'GOAL SET' },
            ),
            forwardToAgent: agentBumpMessage(created.goal),
        };
    },
};

function renderStatus(g: ReturnType<NonNullable<ReturnType<typeof getGoalFacade>>['get']>): string {
    if (!g) return oneLine('goal', `${STATE.off}  no goal set in this thread`);
    const used = `${g.turnsUsed}/${g.maxTurns}`;
    const last = g.lastVerdict ? ` · last: ${g.lastVerdict}` : '';
    const reason = g.lastReason ? ` (${truncate(g.lastReason, 80)})` : '';
    return panel(
        [
            {
                title: 'goal',
                lines: [
                    row('status', `${statusIcon(g.status)}  ${g.status}`, 14),
                    row('turns', `${used}${last}${reason}`, 14),
                    row('goal', truncate(g.goal, 200), 14),
                ],
            },
        ],
        { header: 'GOAL STATUS' },
    );
}

function statusIcon(s: string): string {
    if (s === 'active') return STATE.ok;
    if (s === 'done') return STATE.ok;
    if (s === 'paused') return STATE.warn;
    return STATE.off;
}

function agentBumpMessage(goal: string): string {
    return `[Goal set] Goal: ${goal}\n\nTake the first concrete step toward this goal now.`;
}

function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function oneLine(title: string, value: string): string {
    return panel([{ title: '', lines: [row(title.toLowerCase(), value, 8)] }]);
}
