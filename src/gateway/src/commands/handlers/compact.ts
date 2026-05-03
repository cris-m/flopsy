/**
 * `/compact` — Summarise and compact the current session history.
 *
 * Reads the active thread's message history, calls the LLM to produce a
 * concise summary, then replaces the checkpoint state with a single synthetic
 * system message containing that summary. This frees context-window space
 * while preserving the continuity the user needs to keep working.
 *
 * Identical in concept to Claude Code's `/compact`.
 *
 * Short sessions (fewer than 10 messages) are left untouched — there is
 * nothing meaningful to compact and the round-trip LLM cost is not worth it.
 */

import type { CommandDef, CommandContext } from '../types';
import { getCompactFacade } from '../compact-facade';
import { panel, row, STATE } from '@flopsy/shared';

export const compactCommand: CommandDef = {
    name: 'compact',
    description: 'Summarise and compact the current session to free context window space.',
    handler: async (ctx: CommandContext): Promise<{ text: string } | null> => {
        const facade = getCompactFacade();
        if (!facade) {
            return {
                text: panel(
                    [
                        {
                            title: '',
                            lines: [
                                row(
                                    'compact',
                                    `${STATE.warn}  session compaction is not available — send any message to continue`,
                                    10,
                                ),
                            ],
                        },
                    ],
                ),
            };
        }

        // threadId format: "<peerId>#<sessionId>" or just the peer routing key
        // when sessions are not active. Strip any session suffix so the facade
        // receives the canonical peer routing key it expects.
        const rawKey = ctx.threadId.split('#')[0] ?? ctx.threadId;

        let result: { messageCount: number; summary: string } | undefined;
        try {
            result = await facade.compact(rawKey);
        } catch (err) {
            return {
                text: panel(
                    [
                        {
                            title: '',
                            lines: [
                                row(
                                    'compact',
                                    `${STATE.fail}  compaction failed: ${err instanceof Error ? err.message : String(err)}`,
                                    10,
                                ),
                            ],
                        },
                    ],
                ),
            };
        }

        if (!result) {
            return {
                text: panel(
                    [
                        {
                            title: '',
                            lines: [
                                row(
                                    'compact',
                                    `${STATE.warn}  session is too short or has no history to compact`,
                                    10,
                                ),
                            ],
                        },
                    ],
                ),
            };
        }

        const meta = [
            row('status', `${STATE.ok}  session compacted`, 14),
            row('condensed', `${result.messageCount} message${result.messageCount === 1 ? '' : 's'}`, 14),
        ];

        // The summary often contains markdown the model produced (bullets,
        // bold, etc). Putting it inside the fenced panel locks it into the
        // monospace code rail — channels that render markdown (chat TUI,
        // Telegram, Discord) end up showing literal `**`/`*` instead of
        // formatting. Render the metadata block in the fence, then drop
        // the summary outside as a regular markdown paragraph that the
        // chat TUI's renderMarkdown() can style properly.
        return {
            text: panel(
                [{ title: 'compact', lines: meta }],
                {
                    header: 'SESSION COMPACTED',
                    footer: `**Summary**\n\n${result.summary}`,
                },
            ),
        };
    },
};
