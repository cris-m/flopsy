/**
 * send_message — agent-driven outbound delivery.
 *
 * Instead of relying on the final `messages.at(-1)` being sent to the user,
 * the agent can call this tool to push text immediately. Used for:
 *   - Progress updates during long tasks ("scaffolding done, writing routes…")
 *   - Partial results before the turn ends
 *   - Mid-turn clarifying questions
 *   - The final answer (when the agent wants control over timing)
 *
 * When this tool fires, it calls `callbacks.setDidSendViaTool()` — the
 * handler then drops the final `messages.at(-1)` so the agent's private
 * "I have replied" closing isn't echoed to the user.
 *
 * Wiring contract:
 *   The tool reads from `ctx.configurable`:
 *     - onReply(text): (text: string) => Promise<void> | void
 *     - setDidSendViaTool(): () => void
 *   Both come from the gateway's `AgentCallbacks`. TeamHandler must forward
 *   them through `configurable` when invoking the agent.
 */

import { z } from 'zod';
import { defineTool } from 'flopsygraph';

export interface SendMessageReplyOptions {
    readonly buttons?: ReadonlyArray<{
        readonly label: string;
        readonly value: string;
        readonly style?: 'primary' | 'secondary' | 'success' | 'danger';
    }>;
    readonly media?: ReadonlyArray<{
        readonly type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
        readonly url?: string;
        readonly data?: string;
        readonly mimeType?: string;
        readonly fileName?: string;
        readonly caption?: string;
    }>;
}

export interface SendMessageConfigurable {
    onReply: (text: string, options?: SendMessageReplyOptions) => Promise<void> | void;
    setDidSendViaTool: () => void;
}

export const sendMessageTool = defineTool({
    name: 'send_message',
    description: [
        'Send a message to the user RIGHT NOW while you are still working.',
        'Use this for:',
        '  - Progress updates during long tasks ("Scaffolding done, writing routes...")',
        '  - Partial results you want to share early',
        '  - Clarifying questions mid-task',
        '  - Final answers when your task is complete',
        'Your final text response is sent AUTOMATICALLY if you never call this tool.',
        'Call this tool when you want to control the content and timing yourself.',
        'Do NOT duplicate your final tool call text in your closing response — it will be dropped.',
    ].join('\n'),
    schema: z.object({
        text: z.string().min(1).describe('The message to send to the user.'),
        buttons: z
            .array(
                z.object({
                    label: z.string().min(1).max(80).describe('Text shown on the button.'),
                    value: z
                        .string()
                        .min(1)
                        .max(64)
                        .describe(
                            'The value delivered back when the button is tapped. For plan approval use literal "go" / "edit" / "no" so the regex classifier matches.',
                        ),
                    style: z
                        .enum(['primary', 'secondary', 'success', 'danger'])
                        .optional()
                        .describe(
                            'Button colour — DISCORD ONLY (primary=blue, secondary=gray, success=green, danger=red). Telegram ignores this field (all inline buttons render in the same neutral style). Omit if you want a lightweight button on any channel.',
                        ),
                }),
            )
            .max(9)
            .optional()
            .describe(
                'Optional interactive buttons. Channels that support inline keyboards (Telegram, Discord, Slack) render these. Channels without button support drop them silently. A tap synthesizes a user message containing the button `value` so existing classifiers still work.',
            ),
        media: z
            .array(
                z.object({
                    type: z
                        .enum(['image', 'video', 'audio', 'document', 'sticker'])
                        .describe('Media type — affects which upload API the channel uses.'),
                    url: z.string().optional().describe('Remote URL or local file path.'),
                    data: z
                        .string()
                        .optional()
                        .describe('Base64-encoded payload (alternative to url).'),
                    mimeType: z.string().optional().describe('MIME type, e.g. "image/png".'),
                    fileName: z
                        .string()
                        .optional()
                        .describe('Display filename (documents only).'),
                    caption: z.string().optional().describe('Caption shown under the file.'),
                }),
            )
            .max(10)
            .optional()
            .describe(
                'Media attachments (images, videos, audio, documents). Each item must have either `url` OR `data`. Channels that support media (Telegram, Discord, WhatsApp, Signal) upload natively. For polls use `send_poll` — this field is only for file/media attachments.',
            ),
    }),
    execute: async ({ text, buttons, media }, ctx) => {
        const cfg = (ctx.configurable ?? {}) as Partial<SendMessageConfigurable>;
        const onReply = cfg.onReply;
        const setDidSendViaTool = cfg.setDidSendViaTool;

        if (typeof onReply !== 'function') {
            // No delivery callback wired — the agent is running outside a
            // platform context (e.g. a standalone eval). Return a no-op
            // success so the model doesn't loop; callers who need delivery
            // must wire the callbacks.
            return 'send_message: no onReply configured; message dropped';
        }

        try {
            const options = buttons || media ? { buttons, media } : undefined;
            await onReply(text, options);
        } catch (err) {
            return `send_message: delivery failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        // Flag AFTER successful delivery. If the send throws, the caller
        // still wants to fall back to messages.at(-1) — never silently lose
        // the user's final answer because a network blip dropped our only
        // tool-driven send.
        if (typeof setDidSendViaTool === 'function') {
            setDidSendViaTool();
        }

        return 'sent';
    },
});
