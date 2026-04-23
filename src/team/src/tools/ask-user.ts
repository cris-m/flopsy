/**
 * ask_user — pause the agent's turn and ask the user a specific question.
 *
 * Ported in spirit from Claude Code's `AskUserQuestionTool` and Hermes's
 * `clarify_tool`, adapted for multi-channel delivery:
 *
 *   - On Telegram/Discord (buttons capability): renders the options as an
 *     inline keyboard / message components. User taps one → synthesized
 *     user-message with body=value comes back next turn.
 *   - On text-only channels (SMS, WhatsApp basic, iMessage): renders as a
 *     numbered prompt ("Reply with a number: 1. Python 2. Go 3. Other").
 *     User replies with the number or text → fresh turn.
 *
 * Design choices vs. the claude-code implementation:
 *   - SINGLE question per call (not 1-4 batched) — stacking button sets on
 *     mobile hurts more than it helps. One question per turn reads better.
 *   - NO `preview` field — button UIs don't render rich artifacts.
 *   - ALWAYS-on "Other" option (unless allowOther=false) — gives the user
 *     a free-text escape hatch matching claude-code's behaviour.
 *   - STRUCTURED result string describing the pending state so the agent
 *     knows the next user message is an answer to this question.
 *
 * What makes this distinct from `send_message` with `buttons`?
 *
 *   `send_message(buttons)` is a fire-and-continue surface. The agent keeps
 *   tools ready for whatever the user does next.
 *
 *   `ask_user` is a fire-and-STOP surface. The description + role delta
 *   explicitly teach the agent: "after this, your turn ends — you will
 *   resume with the user's answer as their next message." Semantics change,
 *   not plumbing.
 *
 * Wiring contract (from ctx.configurable):
 *   - onReply(text, options)        — channel-scoped delivery (same as send_message)
 *   - setDidSendViaTool()           — so the closing .messages[-1] isn't echoed
 *   - channelName, channelCapabilities (read-only) — informational; model
 *     already sees these via runtime block. The tool uses channelCapabilities
 *     to decide whether to attach buttons or fall back to text.
 */

import { z } from 'zod';
import { defineTool } from 'flopsygraph';

export interface AskUserOption {
    readonly label: string;
    readonly value: string;
    readonly description?: string;
    readonly style?: 'primary' | 'secondary' | 'success' | 'danger';
}

export interface AskUserConfigurable {
    onReply: (
        text: string,
        options?: {
            buttons?: ReadonlyArray<{
                label: string;
                value: string;
                style?: 'primary' | 'secondary' | 'success' | 'danger';
            }>;
        },
    ) => Promise<void> | void;
    setDidSendViaTool: () => void;
    channelCapabilities?: readonly string[];
}

/**
 * Literal value the auto-appended "Other" button carries. Kept stable so
 * the role delta can match on it if we ever need to branch on "user chose
 * Other" in the future. Namespaced to avoid collisions with real option
 * values.
 */
const OTHER_VALUE = '__other__';

export const askUserTool = defineTool({
    name: 'ask_user',
    description: [
        'USE THIS TOOL when you need a SPECIFIC ANSWER from the user before',
        'you can proceed, and the answer fits into a small set of choices',
        '(2-4 options). Examples: "Which language?", "What timezone?",',
        '"Local or cloud deployment?". Your turn ENDS after calling this;',
        'you will resume on the user\'s next message.',
        '',
        'An "Other" option is auto-appended unless allowOther=false — when',
        'the user taps "Other" (or on a text-only channel types anything',
        'that doesn\'t match a number/option), their free-text reply is',
        'your answer.',
        '',
        'Channel behaviour (you also see `capabilities: ...` in <runtime>):',
        '  - buttons-capable (Telegram, Discord): options render as taps',
        '  - text-only (SMS, basic WhatsApp/iMessage): "Reply with number:',
        '    1. Python  2. Go  3. Other" — user answers by digit or text',
        '',
        'DO NOT use ask_user for:',
        '  - Plan approval — use create_plan + send_message(buttons) with',
        '    the explicit go/edit/no values; the approval gate handles it',
        '  - Group/multiple-voter questions — use send_poll',
        '  - Open-ended conversation ("how are you?") — just reply normally',
        '  - Questions the user already answered earlier — read the thread',
        '',
        'Schema tips:',
        '  - Keep options 2-4. Add "Other" via allowOther (default true).',
        '  - `value` is the classifier token ("python", not "Python 🐍").',
        '  - `label` is the button text (display only).',
        '  - If ONE option is recommended, put it first and add',
        '    "(recommended)" to its label.',
    ].join('\n'),
    schema: z.object({
        question: z
            .string()
            .min(1)
            .max(280)
            .describe(
                'The question to ask. Must be clear, specific, and end with a question mark. Shown verbatim to the user above the options.',
            ),
        options: z
            .array(
                z.object({
                    label: z
                        .string()
                        .min(1)
                        .max(40)
                        .describe(
                            'Button text shown to the user (1-40 chars). If recommended, append "(recommended)".',
                        ),
                    value: z
                        .string()
                        .min(1)
                        .max(40)
                        .describe(
                            'Classifier token returned when this option is picked. Use a stable lowercase slug (e.g. "python", "go", "typescript") — NOT the label with emoji/punctuation.',
                        ),
                    description: z
                        .string()
                        .max(120)
                        .optional()
                        .describe(
                            'Short context about what this option means. Rendered inline on channels that support it; ignored on Telegram inline keyboards.',
                        ),
                    style: z
                        .enum(['primary', 'secondary', 'success', 'danger'])
                        .optional()
                        .describe(
                            'Discord-only visual style. Omit unless you want a specific colour — Telegram renders all buttons neutrally.',
                        ),
                }),
            )
            .min(2)
            .max(4)
            .describe(
                'The choices for the question. 2-4 distinct options; "Other" is auto-appended unless allowOther=false.',
            ),
        allowOther: z
            .boolean()
            .optional()
            .describe(
                'Whether to auto-append an "Other" option so the user can free-text. Default true. Set false only when the options are exhaustive and free-text would not make sense (e.g. "Monday or Tuesday?").',
            ),
    }),
    execute: async ({ question, options, allowOther }, ctx) => {
        const cfg = (ctx.configurable ?? {}) as Partial<AskUserConfigurable>;
        const onReply = cfg.onReply;
        const setDidSendViaTool = cfg.setDidSendViaTool;
        const capabilities = cfg.channelCapabilities ?? [];

        if (typeof onReply !== 'function') {
            return 'ask_user: no onReply configured; question dropped';
        }

        // Compose the final option list with the optional "Other" suffix.
        // Label differs from the stored value so "Other" reads naturally in
        // text while the classifier key stays stable (OTHER_VALUE).
        const withOther: AskUserOption[] = [
            ...options,
            ...(allowOther !== false
                ? [
                      {
                          label: 'Other',
                          value: OTHER_VALUE,
                          style: 'secondary' as const,
                      },
                  ]
                : []),
        ];

        const supportsButtons = capabilities.includes('buttons');

        if (supportsButtons) {
            // Native-button path: channel adapter renders the inline keyboard
            // / components; tapped value comes back as a synthesized user
            // message on the next turn (gateway's interactive-button pipeline).
            try {
                await onReply(question, {
                    buttons: withOther.map((o) => ({
                        label: o.label,
                        value: o.value,
                        style: o.style,
                    })),
                });
            } catch (err) {
                return `ask_user: delivery failed: ${err instanceof Error ? err.message : String(err)}`;
            }
        } else {
            // Text-only path: render as a numbered prompt. The user replies
            // with a number OR free text — either way the next turn delivers
            // the answer as a normal user message.
            const numbered = withOther
                .map((o, i) => {
                    const descSuffix = o.description ? ` — ${o.description}` : '';
                    return `${i + 1}. ${o.label}${descSuffix}`;
                })
                .join('\n');
            const body = `${question}\n\nReply with a number or your own answer:\n${numbered}`;
            try {
                await onReply(body);
            } catch (err) {
                return `ask_user: delivery failed: ${err instanceof Error ? err.message : String(err)}`;
            }
        }

        if (typeof setDidSendViaTool === 'function') {
            setDidSendViaTool();
        }

        // Structured tool result — the agent sees this as the tool's output
        // and learns the turn should end here. Describes the pending state
        // so if the agent is checkpointed + resumed mid-reasoning (possible
        // with our SqliteCheckpointStore), it re-enters knowing a question
        // is outstanding.
        const validValues = withOther.map((o) => o.value).join(', ');
        return [
            `Question sent to user (${supportsButtons ? 'buttons' : 'text-only'}).`,
            `Awaiting answer. Your turn ends here.`,
            `Valid option values: [${validValues}]. The user's next message`,
            `is the answer — it will match one of these values (button tap),`,
            `a digit index, or free text (for "Other" or open answer).`,
        ].join(' ');
    },
});
