import type { CommandContext, CommandDef } from '../types';
import { getScheduleFacade } from '../schedule-facade';
import { panel, row, STATE } from '@flopsy/shared';

/**
 * `/improve` — manually trigger the self-improve heartbeat NOW.
 *
 * The self-improve heartbeat reads recent proactive-fire outcomes from
 * `learning.db`, detects anti-patterns (narration suspects, low_response,
 * recurring suppressions), and appends lessons to `skills/proactive/SKILL.md`.
 * It normally fires every 4h via the scheduler; this command lets the user
 * run it on-demand (e.g. after a known suspect delivery to capture the
 * lesson immediately).
 *
 * Outcome surfaces via `/insights` — look for last-skill-write time +
 * `proactive` skill view/patch counters.
 */
export const improveCommand: CommandDef = {
    name: 'improve',
    aliases: ['self-improve'],
    description: 'Manually trigger the self-improve heartbeat now (writes new lessons to skills/proactive).',
    scope: 'admin',
    handler: async (_ctx: CommandContext) => {
        const facade = getScheduleFacade();
        if (!facade) {
            return {
                text: panel(
                    [{ title: 'improve', lines: [row('status', `${STATE.warn}  facade not wired (proactive engine not active)`, 14)] }],
                    { header: 'IMPROVE' },
                ),
            };
        }
        try {
            const result = await facade.trigger('self-improve');
            if (result.ok) {
                return {
                    text: panel(
                        [{ title: 'improve', lines: [
                            row('status',  `${STATE.ok}  triggered`, 14),
                            row('detail',  result.message ?? 'fire scheduled', 14),
                            row('check',   '`/insights` → look at last skill write + proactive view/patch', 14),
                        ] }],
                        { header: 'IMPROVE' },
                    ),
                };
            }
            return {
                text: panel(
                    [{ title: 'improve', lines: [
                        row('status', `${STATE.fail}  failed`, 14),
                        row('reason', result.message ?? 'unknown', 14),
                    ] }],
                    { header: 'IMPROVE' },
                ),
            };
        } catch (err) {
            return {
                text: panel(
                    [{ title: 'improve', lines: [
                        row('status', `${STATE.fail}  error`, 14),
                        row('detail', (err as Error).message.slice(0, 100), 14),
                    ] }],
                    { header: 'IMPROVE' },
                ),
            };
        }
    },
};
