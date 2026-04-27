/**
 * `/new` — Start a fresh conversation session.
 *
 * Force-closes the current session for this peer and opens a new one.
 * The next agent turn lands in the fresh session with a clean slate.
 * Long-term facts and preferences (from the learning harness) persist —
 * only the conversational context is reset.
 */

import type { CommandDef, CommandContext } from '../types';
import { getSessionFacade } from '../session-facade';

export const newCommand: CommandDef = {
    name: 'new',
    aliases: ['reset', 'fresh'],
    description: 'Start a fresh conversation session. Facts + preferences are kept.',
    handler: async (ctx: CommandContext): Promise<{ text: string } | null> => {
        const facade = getSessionFacade();
        if (!facade) {
            return {
                text: '_Session management is not active. Send any message to continue your current session._',
            };
        }

        const newSessionId = facade.forceNewSession(ctx.threadId);
        if (!newSessionId) {
            return {
                text: '_Could not open a new session right now. Please try again._',
            };
        }

        return {
            text:
                `✅ *New session started* (\`${newSessionId}\`).\n\n` +
                `Your conversation context has been reset. Facts and preferences are preserved — I still know who you are.`,
        };
    },
};
