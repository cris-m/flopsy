import type { CommandContext, CommandDef } from '../types';
import { getPlanFacade } from '../plan-facade';

export const planCommand: CommandDef = {
    name: 'plan',
    description: 'Plan a task before executing. Use: /plan <task>, or /plan cancel to abort.',
    handler: async (ctx: CommandContext) => {
        const raw = ctx.rawArgs.trim();

        if (raw === '') {
            return {
                text: [
                    'PLAN MODE',
                    '─────────',
                    'Use plan mode when you want me to think through an approach',
                    'and get your sign-off before doing anything.',
                    '',
                    'Activate:',
                    '  `/plan <task>`   — I draft a plan and send it with',
                    '                     go / edit / no buttons.',
                    '',
                    'When a plan is on screen:',
                    '  reply "go"      — approved, I execute',
                    '  reply "no"      — rejected, plan dropped',
                    '  anything else   — counts as an edit, I redraft',
                    '',
                    'Cancel:',
                    '  `/plan cancel`   — drop any active plan and continue',
                    '                     in normal mode.',
                ].join('\n'),
            };
        }

        if (raw === 'cancel' || raw === 'stop' || raw === 'abort') {
            // Hard reset via the facade, plus an agent nudge so its next
            // turn doesn't reference the dropped plan.
            const facade = getPlanFacade();
            const cleared = facade?.cancel(ctx.threadId) ?? false;

            if (!facade) {
                return {
                    text: 'Cancelling plan mode.',
                    forwardToAgent:
                        '[The user invoked `/plan cancel`. If you have an active plan, drop it now and continue normally.]',
                };
            }

            return {
                text: cleared
                    ? 'Plan dropped. Send a fresh request when ready.'
                    : 'No active plan to cancel.',
                forwardToAgent: cleared
                    ? '[The user invoked `/plan cancel`. The plan-mode state was just cleared at the interceptor level — there is no longer any plan or drafting state for this thread. Acknowledge briefly and wait for their next request. Do NOT reference the dropped plan.]'
                    : undefined,
            };
        }

        return {
            text: `Drafting a plan for: ${truncate(raw, 80)}`,
            forwardToAgent:
                '[The user invoked `/plan` for this task — they want plan mode. Use `create_plan` to draft the approach, ' +
                'send it via `send_message` with the standard `go` / `edit` / `no` buttons, and wait for approval before executing. ' +
                'Do NOT call `delegate_task` or `spawn_background_task` until they approve.]\n\n' +
                raw,
        };
    },
};

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}
