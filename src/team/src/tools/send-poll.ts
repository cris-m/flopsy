/**
 * send_poll — agent-driven native poll delivery.
 *
 * Sends a Telegram / Discord native poll (aggregated voting, shown in the
 * native poll UI) or a text fallback on channels without poll support.
 * Different from `send_message` because polls have their own schema and
 * their own round-trip (`poll_answer` events, not `callback_query`).
 *
 * Wiring contract:
 *   ctx.configurable reads:
 *     - sendPoll(question, options, pollOpts?) — channel-scoped delivery
 *     - setDidSendViaTool()                   — ends the turn cleanly
 *
 * The TeamHandler injects these from AgentCallbacks.
 */

import { z } from 'zod';
import { defineTool } from 'flopsygraph';

export interface SendPollOptions {
    /**
     * Whether voter identities are hidden. Telegram default true;
     * FlopsyBot default false so the agent can read vote signals.
     */
    readonly anonymous?: boolean;
    /** Whether a voter can pick more than one option. */
    readonly allowMultiple?: boolean;
    /** Auto-close after N hours (Discord 1-768h; Telegram <= 10 minutes). */
    readonly durationHours?: number;
}

export interface SendPollConfigurable {
    sendPoll: (
        question: string,
        options: readonly string[],
        pollOptions?: SendPollOptions,
    ) => Promise<void> | void;
    setDidSendViaTool: () => void;
}

export const sendPollTool = defineTool({
    name: 'send_poll',
    description: [
        'USE THIS TOOL when the user asks for a "poll", "pool" (typo for poll),',
        '"vote", "survey", "which one", "pick one", or any phrasing that implies',
        'multiple-choice voting. Do NOT use send_message with buttons for poll',
        'requests — polls and buttons are different UX.',
        '',
        'Sends a native aggregated-voting UI. Native on Telegram + Discord;',
        'other channels fall back to numbered text ("1. A / 2. B"). Users vote',
        'by tapping the poll option (native) or replying with the number.',
        '',
        'Limits: question ≤ 300 chars; 2-10 options, each ≤ 100 chars.',
        'Default anonymous=false so the agent can see who voted.',
        '',
        'Prefer send_message+buttons only for binary approvals (plan go/edit/no)',
        'and 2-4 choice disambiguation — not for "make a poll" requests.',
    ].join('\n'),
    schema: z.object({
        question: z.string().min(1).max(300).describe('The poll question.'),
        options: z
            .array(z.string().min(1).max(100))
            .min(2)
            .max(10)
            .describe('Poll choices (2-10 items).'),
        anonymous: z
            .boolean()
            .optional()
            .describe(
                'Hide voter identities. Telegram defaults true; keep it false if you need to read vote signals from individual users.',
            ),
        allowMultiple: z
            .boolean()
            .optional()
            .describe('Permit selecting more than one option.'),
        durationHours: z
            .number()
            .positive()
            .max(768)
            .optional()
            .describe(
                'Auto-close after N hours. Discord: 1-768h. Telegram: max ~0.17h (10 minutes).',
            ),
    }),
    execute: async ({ question, options, anonymous, allowMultiple, durationHours }, ctx) => {
        const cfg = (ctx.configurable ?? {}) as Partial<SendPollConfigurable>;
        const sendPoll = cfg.sendPoll;
        const setDidSendViaTool = cfg.setDidSendViaTool;

        if (typeof sendPoll !== 'function') {
            return 'send_poll: no sendPoll configured; poll dropped';
        }

        try {
            await sendPoll(question, options, {
                anonymous,
                allowMultiple,
                durationHours,
            });
        } catch (err) {
            return `send_poll: delivery failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        if (typeof setDidSendViaTool === 'function') {
            setDidSendViaTool();
        }

        return `poll sent (${options.length} options)`;
    },
});
