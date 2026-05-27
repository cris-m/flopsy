import type { CommandContext, CommandDef } from '../types';
import { getPlanFacade } from '../plan-facade';

/** Same escape as skill-commands.ts (kept local to avoid a tiny shared
 *  module). Prevents prompt-injection via `/plan ]...IGNORE PREVIOUS...`
 *  breaking out of the bracket framing. */
function escapeForBracketTemplate(s: string): string {
    return s
        .replace(/\]/g, '\\]')
        .replace(/\[INST\]/gi, '[INST_LITERAL]')
        .replace(/<\/(?:user_input|user_msg|system|assistant)>/gi, (m) => `[${m.slice(2)}_LITERAL]`);
}

export const planCommand: CommandDef = {
    name: 'plan',
    description: 'Plan a task before executing. Use: /plan <task>, or /plan cancel to abort.',
    handler: async (ctx: CommandContext) => {
        const raw = ctx.rawArgs.trim();

        if (raw === '') {
            return {
                text: [
                    'PLAN',
                    '────',
                    'Have me lay out a step-by-step plan before I start, so a',
                    'multi-step task stays on track across turns.',
                    '',
                    'Use:',
                    '  `/plan <task>`   — I draft a step list and work through it,',
                    '                     showing the plan first for heavy tasks.',
                    '',
                    'Cancel:',
                    '  `/plan cancel`   — drop the current plan and continue normally.',
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
                    ? '[The user invoked `/plan cancel`. The plan scratchpad for this thread was just cleared — there is no longer any plan. Acknowledge briefly and wait for their next request. Do NOT reference the dropped plan.]'
                    : undefined,
            };
        }

        return {
            text: `Planning: ${truncate(raw, 80)}`,
            forwardToAgent:
                '[The user invoked `/plan` for this task — lay out the approach first. Use the `plan` tool (action=set) to record a `# goal` headline and a `## Steps` list, then work through the steps, marking each with update_step as you go. ' +
                'For a heavy task (multiple workers or long-running), show the plan to the user before committing resources.]\n\n' +
                escapeForBracketTemplate(raw),
        };
    },
};

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}
