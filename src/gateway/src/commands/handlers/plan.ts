/**
 * `/plan` — explicit plan-mode gate from chat.
 *
 * Plan mode is normally entered by the agent itself (it calls `create_plan`
 * when a task is heavy enough to warrant user review). `/plan` lets the user
 * force it: the agent will draft a plan, present it with go/edit/no buttons,
 * and only execute after explicit approval.
 *
 * Three forms:
 *   /plan                       — show usage + how to interact with an active plan
 *   /plan <task description>    — arm plan mode for the task
 *   /plan cancel | stop | abort — drop any active plan
 *
 * Implementation: the handler returns `forwardToAgent` so the channel-worker
 * injects a bracketed nudge into the agent's message queue. The agent already
 * knows about `create_plan` from its system prompt — the bracketed prefix
 * just makes plan mode the explicit choice for this task.
 */

import type { CommandContext, CommandDef } from '../types';

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
            return {
                text: 'Cancelling plan mode.',
                forwardToAgent:
                    '[The user invoked `/plan cancel`. If you have an active plan in drafting state, drop it now and confirm in one short sentence. ' +
                    'Then continue normally — they may follow up with a fresh request.]',
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
