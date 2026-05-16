import type { CommandDef, CommandContext } from '../types';
import { runScheduleCommand } from './schedule-shared';

export const heartbeatCommand: CommandDef = {
    name: 'heartbeat',
    aliases: ['hb'],
    description:
        'Manage scheduled heartbeats: `/heartbeat list|show|status|enable|disable|trigger|tick|remove|fires`.',
    // Admin: same rationale as /cron — mutating-and-LLM-fanout surface.
    scope: 'admin',
    handler: (ctx: CommandContext) => runScheduleCommand('heartbeat', ctx.args),
};
