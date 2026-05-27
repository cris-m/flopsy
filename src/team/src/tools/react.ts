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
        'Drop an emoji reaction on the user\'s last message. Use for acknowledgement, agreement, or mood — alone or alongside a text reply. Not a substitute for answering a real question.',
        '',
        'Args:',
        '  emoji — any single emoji string, 1-16 chars.',
        '',
        'Supported on Telegram, Discord, Slack, WhatsApp. No-ops silently on platforms without reaction support (iMessage, Line).',
    ].join('\n'),
    schema: z.object({
        emoji: z
            .string()
            .min(1)
            .max(16)
            .describe('The emoji to react with (e.g. "👀", "🔥", "😬", "🎯").'),
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
