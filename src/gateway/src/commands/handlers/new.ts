import type { CommandDef, CommandContext } from '../types';
import { getSessionFacade } from '../session-facade';
import { panel, row, STATE } from '@flopsy/shared';

export const newCommand: CommandDef = {
    name: 'new',
    aliases: ['reset', 'fresh'],
    description: 'Start a fresh conversation session. Facts + preferences are kept.',
    handler: async (ctx: CommandContext): Promise<{ text: string } | null> => {
        const facade = getSessionFacade();
        if (!facade) {
            return {
                text: panel(
                    [{ title: '', lines: [row('session', `${STATE.warn}  not active — send any message to continue current session`, 8)] }],
                ),
            };
        }

        const result = await facade.forceNewSession(ctx.threadId);
        if (!result) {
            return {
                text: panel(
                    [{ title: '', lines: [row('session', `${STATE.fail}  could not open a new session right now`, 8)] }],
                ),
            };
        }

        const lines = [
            row('status', `${STATE.ok}  new session started`, 12),
            row('id', result.sessionId, 12),
            row('memory', 'profile + notes + directives kept', 12),
        ];
        if (result.summary) {
            lines.push(row('last', result.summary, 12));
        }

        return {
            text: panel(
                [{ title: 'session', lines }],
                { header: 'NEW SESSION' },
            ),
        };
    },
};
