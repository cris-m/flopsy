import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import type { TaskRegistry } from '../state/task-registry';

export interface NotifyTeammateConfigurable {
    registry?: TaskRegistry;
    agentName?: string;
}

export const notifyTeammateTool = defineTool({
    name: 'notify_teammate',
    description: [
        'Send a short message to another teammate without routing through the main agent.',
        'Use when your work overlaps another domain or when you discovered something they should act on.',
        'The teammate will see your message on their next invocation.',
        '',
        'Rules:',
        '  - One paragraph max — include only what they need to act.',
        '  - Prefer notifying over returning to gandalf when the finding is actionable for the target.',
        '  - Do NOT use for social chat or status updates — only cross-domain handoffs.',
        '  - Max 3 calls per turn; exceeding this returns an error.',
    ].join('\n'),
    schema: z.object({
        teammate: z.string().describe('Target worker name (e.g. "aragorn", "legolas", "gimli").'),
        message: z.string().describe('Brief message — one paragraph max. What they need to know and why.'),
        urgency: z.enum(['normal', 'blocking']).optional().describe('blocking = they should see this before anything else.'),
    }),
    execute: async (args, ctx) => {
        const cfg = (ctx.configurable ?? {}) as NotifyTeammateConfigurable;
        const registry = cfg.registry;
        if (!registry) {
            return 'notify_teammate: no TaskRegistry available.';
        }

        // Rate limit: max 3 notifications per worker per turn
        const notifyCount = (ctx.configurable as Record<string, unknown>)?.__notifyCount as number | undefined ?? 0;
        if (notifyCount >= 3) {
            return 'notify_teammate: rate limit reached (max 3 per turn). Return findings to gandalf instead.';
        }
        (ctx.configurable as Record<string, unknown>).__notifyCount = notifyCount + 1;

        const sender = cfg.agentName ?? 'unknown';
        const formatted = [
            `<message-from-teammate>`,
            `From: ${sender}`,
            `Urgency: ${args.urgency ?? 'normal'}`,
            args.message,
            `</message-from-teammate>`,
        ].join('\n');

        // If target has an active task, push to its pending buffer for mid-turn delivery
        const active = registry.findActiveTeammate(args.teammate);
        if (active) {
            registry.pushPending(active.id, formatted);
            return `Notified ${args.teammate} (active task ${active.id}).`;
        }

        // Otherwise queue for next invocation
        registry.pushTeammateMessage(args.teammate, formatted);
        return `Queued message for ${args.teammate} — will be delivered on their next invocation.`;
    },
});
