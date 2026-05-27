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

const OTHER_VALUE = '__other__';

export const askUserTool = defineTool({
    name: 'ask_user',
    description: [
        'Ask the user a question with 2-4 fixed choices and end your turn. Resumes on the user\'s next message. An "Other" option auto-appends unless allowOther=false; free-text replies (or non-matching text on text-only channels) become the answer.',
        '',
        'Channel behaviour (see `capabilities` in <runtime>):',
        '  buttons-capable (Telegram, Discord) — options render as taps.',
        '  text-only (SMS, basic WhatsApp/iMessage) — "Reply with number: 1. Python  2. Go  3. Other".',
        '',
        'Style:',
        '  - 2-4 options. `value` is a stable lowercase slug ("python"); `label` is display text.',
        '  - if one option is recommended, put it first and append "(recommended)" to its label.',
        '  - set allowOther=false only when options are exhaustive ("Monday or Tuesday?").',
        '',
        'Don\'t use for group polling (use send_poll), open-ended conversation, or questions the user already answered earlier in the thread.',
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
