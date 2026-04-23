/**
 * react — drop an emoji reaction on the user's last message.
 *
 * Fast, cheap, expressive. Often beats a full text reply when a user's
 * message just needs acknowledgement ("heard you", "this is cool", "ugh
 * same"). Does NOT count as a reply — the model can still produce a final
 * text answer or call send_message afterwards.
 *
 * Wiring contract:
 *   ctx.configurable.reactToUserMessage(emoji, messageId?): Promise<void>
 *   Supplied by the gateway's AgentCallbacks. If absent (no platform
 *   wired), the tool returns a no-op diagnostic and moves on.
 *
 * Platforms without reaction support (iMessage, Line) silently no-op at
 * the channel layer — the tool still returns "reacted" from the LLM's
 * perspective. Better UX than failing loud for a cosmetic tool.
 */

import { z } from 'zod';
import { defineTool } from 'flopsygraph';

export interface ReactConfigurable {
    reactToUserMessage: (emoji: string, messageId?: string) => Promise<void>;
}

export const reactTool = defineTool({
    name: 'react',
    description: [
        'Drop an emoji reaction on the user\'s last message. Fast, cheap, expressive.',
        'Use when:',
        '  - Acknowledgement is enough (👀 = "I see you", ✅ = "got it", 🫡 = "done")',
        '  - You want to show emotion without writing a sentence (🔥 = "that\'s cool", 😬 = "oof")',
        '  - Alongside a text reply when one reaction isn\'t enough',
        'Use ANY emoji that fits — not just defaults. Match the energy of the moment.',
        'This is NOT a substitute for answering a real question — use it for acknowledgement, not as an excuse to stay silent.',
        'Only supported on platforms that allow reactions (Telegram, Discord, Slack, WhatsApp). No-ops silently elsewhere.',
    ].join('\n'),
    schema: z.object({
        emoji: z
            .string()
            .min(1)
            .max(16)
            .describe('The emoji to react with (e.g. "👀", "🔥", "😬", "✅").'),
    }),
    execute: async ({ emoji }, ctx) => {
        const cfg = (ctx.configurable ?? {}) as Partial<ReactConfigurable>;
        const reactFn = cfg.reactToUserMessage;

        if (typeof reactFn !== 'function') {
            return 'react: no reaction callback configured; reaction dropped';
        }

        try {
            await reactFn(emoji);
            return `reacted ${emoji}`;
        } catch (err) {
            return `react: failed: ${err instanceof Error ? err.message : String(err)}`;
        }
    },
});
