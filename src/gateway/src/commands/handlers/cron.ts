import type { CommandDef, CommandContext } from '../types';
import { runScheduleCommand } from './schedule-shared';

export const cronCommand: CommandDef = {
    name: 'cron',
    description:
        'Manage scheduled cron jobs: `/cron list|show|status|enable|disable|trigger|tick|remove|fires`.',
    // Admin: enable/disable/remove/trigger/tick all mutate runtime state
    // and `tick` fans out LLM calls. Read-only verbs (list/show/status/fires)
    // are blocked too — the simplest safe default for a single-operator
    // system. Non-operators see a clear refusal.
    scope: 'admin',
    handler: (ctx: CommandContext) => runScheduleCommand('cron', ctx.args),
};
