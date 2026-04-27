/**
 * manage_schedule — create + manage proactive heartbeats and cron jobs at
 * runtime, persisted to ~/.flopsy/state/proactive.db (separate from the
 * static config in flopsy.json5).
 *
 * Operations:
 *   create    — add a new heartbeat or cron job (registered immediately)
 *   list      — show all runtime-created schedules
 *   delete    — remove a runtime schedule by id
 *   disable   — mark disabled (takes effect on next restart)
 *   enable    — re-enable a previously disabled schedule
 *
 * Schedule types:
 *   heartbeat — fires on a simple interval ("30m", "1h", "1d")
 *   cron      — three flavours:
 *                 at     — fire once at epoch ms (naturally oneshot)
 *                 every  — fixed interval in ms
 *                 cron   — 5-field cron expression with IANA timezone
 *
 * Flat schema — OpenAI requires type:"object" at the top level and rejects
 * discriminatedUnion's oneOf output. Fields are validated per-operation in
 * `execute()` with readable error strings.
 */

import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import { copyPromptFile, type HeartbeatDefinitionConfig, type JobDefinitionConfig } from '@flopsy/shared';
import { getScheduleFacade } from './schedule-registry';

const schema = z.object({
    operation: z
        .enum(['create', 'list', 'delete', 'disable', 'enable'])
        .describe('Which operation to perform'),

    // create-only
    scheduleType: z
        .enum(['heartbeat', 'cron'])
        .optional()
        .describe('(create) Which kind of schedule to create'),
    name: z
        .string()
        .optional()
        .describe('(create) Human-readable name. Required for heartbeats.'),
    prompt: z
        .string()
        .optional()
        .describe('(create) Inline prompt the agent will receive when the schedule fires'),
    promptFile: z
        .string()
        .optional()
        .describe('(create) Alternative to `prompt`: path relative to FLOPSY_HOME'),
    deliveryMode: z
        .enum(['always', 'conditional', 'silent'])
        .optional()
        .describe('(create) always|conditional|silent — default "always"'),
    oneshot: z
        .boolean()
        .optional()
        .describe('(create) Fire once then auto-disable (survives restart)'),

    // heartbeat-only
    interval: z
        .string()
        .optional()
        .describe('(create, heartbeat) Duration string: "30s" "5m" "1h" "1d"'),
    activeHoursStart: z
        .number()
        .int()
        .min(0)
        .max(23)
        .optional()
        .describe('(create, heartbeat) Start of active hours 0-23'),
    activeHoursEnd: z
        .number()
        .int()
        .min(0)
        .max(23)
        .optional()
        .describe('(create, heartbeat) End of active hours 0-23'),

    // cron-only
    cronKind: z
        .enum(['at', 'every', 'cron'])
        .optional()
        .describe('(create, cron) at=one shot, every=fixed interval, cron=5-field expr'),
    cronExpr: z
        .string()
        .optional()
        .describe('(create, cron+cronKind=cron) 5-field cron expression'),
    cronTz: z
        .string()
        .optional()
        .describe('(create, cron+cronKind=cron) IANA timezone, e.g. Africa/Nairobi'),
    atMs: z
        .number()
        .optional()
        .describe('(create, cron+cronKind=at) Absolute epoch ms to fire at'),
    everyMs: z
        .number()
        .min(60_000)
        .optional()
        .describe('(create, cron+cronKind=every) Interval in ms (min 60000 = 1 min)'),

    // delete/disable/enable
    id: z
        .string()
        .optional()
        .describe('(delete/disable/enable) The schedule id returned by `list` or `create`'),
});

export const manageScheduleTool = defineTool({
    name: 'manage_schedule',
    description: `Create and manage proactive heartbeats + cron jobs at runtime.

A heartbeat fires on a simple interval ("30m", "1h"). A cron job fires on a
wall-clock schedule (exact time, periodic, or cron expression).

Use this when the user asks things like:
  - "remind me in 2 hours to call mom"       → cron, kind="at", oneshot
  - "check my inbox every 30 min"            → heartbeat, interval="30m"
  - "every Monday at 9am give me a briefing" → cron, kind="cron", expr="0 9 * * 1"
  - "run this one weekly review this Sunday" → cron, kind="cron", oneshot=true

Delivery modes:
  always      — agent runs and its reply is always sent
  conditional — agent returns JSON {shouldDeliver, message, reason}; send only if shouldDeliver=true
  silent      — agent runs for side-effects only; nothing delivered

Anti-repetition is automatic: topics + REPORTED: IDs + embedding similarity.
See docs/proactive.md.

Operations:
  create    — add a new schedule (persists to state, registers immediately)
  list      — show all runtime-created schedules
  delete    — remove a runtime schedule by id
  disable   — pause (takes effect on next restart)
  enable    — resume a previously disabled schedule`,
    schema,
    async execute(args, ctx) {
        const facade = getScheduleFacade();
        if (!facade) {
            return 'Scheduler is not running — the proactive engine was not initialised (check that proactive.enabled = true in flopsy.json5).';
        }

        const configurable = (ctx?.configurable ?? {}) as {
            threadId?: string;
            agentName?: string;
        };
        const createdBy = {
            ...(configurable.threadId ? { threadId: configurable.threadId } : {}),
            ...(configurable.agentName ? { agentName: configurable.agentName } : {}),
        };

        // Recursion guard — matches Hermes' rule: a proactive-invoked agent
        // session cannot create/modify/delete schedules, otherwise a cron or
        // heartbeat fire can spawn more cron jobs and runaway the system.
        // Read-only operations (list) are still allowed so the agent can
        // report what's configured.
        const isProactiveInvoked = configurable.threadId?.startsWith('proactive:') ?? false;
        const isMutating = args.operation !== 'list';
        if (isProactiveInvoked && isMutating) {
            return (
                'Refused: this agent was invoked by the proactive engine — ' +
                'cron/heartbeat-spawned sessions cannot create, delete, or toggle ' +
                'schedules (recursion guard). Ask the user to do it in a normal chat turn.'
            );
        }

        switch (args.operation) {
            case 'list': {
                const all = facade.listSchedules();
                if (all.length === 0) return 'No runtime schedules. Use operation:"create" to add one.';
                const lines = all.map((r) => {
                    let cfg: { name?: string; enabled?: boolean; prompt?: string; promptFile?: string } = {};
                    try {
                        cfg = JSON.parse(r.configJson) as typeof cfg;
                    } catch {
                        /* ignore */
                    }
                    const state = r.enabled ? 'enabled' : 'disabled';
                    const label = cfg.name ?? '(no name)';
                    return `- [${r.kind}] ${r.id} — "${label}" (${state}, created ${new Date(r.createdAt).toISOString()})`;
                });
                return `Runtime schedules (${all.length}):\n${lines.join('\n')}`;
            }

            case 'delete': {
                if (!args.id) return 'Missing required field: id';
                return facade.removeRuntimeSchedule(args.id)
                    ? `Deleted schedule "${args.id}".`
                    : `No runtime schedule with id "${args.id}". Use operation:"list" to see ids.`;
            }

            case 'disable':
            case 'enable': {
                if (!args.id) return 'Missing required field: id';
                const ok = facade.setRuntimeScheduleEnabled(args.id, args.operation === 'enable');
                if (!ok) return `No runtime schedule with id "${args.id}".`;
                return `Schedule "${args.id}" ${args.operation}d.`;
            }

            case 'create': {
                if (!args.scheduleType) return 'Missing required field: scheduleType (heartbeat|cron)';
                if (!args.prompt && !args.promptFile) {
                    return 'Missing prompt: provide either `prompt` or `promptFile`.';
                }

                // Pre-generate the schedule id so we can name the workspace
                // copy `<id>-<basename>` before creating the schedule row.
                const scheduleId =
                    args.scheduleType === 'heartbeat'
                        ? (args.id ?? `runtime-hb-${args.name ?? Date.now()}`)
                        : (args.id ?? `runtime-cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

                // Copy absolute promptFile paths into the workspace.
                let resolvedPromptFile = args.promptFile;
                if (args.promptFile?.startsWith('/')) {
                    try {
                        resolvedPromptFile = await copyPromptFile(
                            args.promptFile,
                            scheduleId,
                            args.scheduleType,
                        );
                    } catch (err) {
                        return `Failed to copy promptFile: ${err instanceof Error ? err.message : String(err)}`;
                    }
                }

                const resolvedArgs = { ...args, id: scheduleId, promptFile: resolvedPromptFile };
                if (args.scheduleType === 'heartbeat') {
                    return createHeartbeat(resolvedArgs, facade, createdBy);
                }
                return createCronJob(resolvedArgs, facade, createdBy);
            }
        }
    },
});

type Args = z.infer<typeof schema>;
type CreatedBy = { threadId?: string; agentName?: string };

function createHeartbeat(args: Args, facade: NonNullable<ReturnType<typeof getScheduleFacade>>, createdBy: CreatedBy): string {
    if (!args.name) return 'Missing required field: name';
    if (!args.interval) return 'Missing required field: interval (e.g. "30m", "1h", "1d")';

    const hb: HeartbeatDefinitionConfig = {
        name: args.name,
        enabled: true,
        interval: args.interval,
        prompt: args.prompt ?? '',
        deliveryMode: args.deliveryMode ?? 'always',
        oneshot: args.oneshot ?? false,
        ...(args.promptFile ? { promptFile: args.promptFile } : {}),
        ...(typeof args.activeHoursStart === 'number' && typeof args.activeHoursEnd === 'number'
            ? { activeHours: { start: args.activeHoursStart, end: args.activeHoursEnd } }
            : {}),
    };
    const ok = facade.addRuntimeHeartbeat(hb, createdBy);
    if (!ok) return `Failed to add heartbeat "${args.name}" (duplicate name or invalid interval).`;
    return `Heartbeat "${args.name}" created (interval=${args.interval}, mode=${hb.deliveryMode}${hb.oneshot ? ', oneshot' : ''}).`;
}

function createCronJob(args: Args, facade: NonNullable<ReturnType<typeof getScheduleFacade>>, createdBy: CreatedBy): string {
    if (!args.cronKind) return 'Missing required field: cronKind (at|every|cron)';

    let schedule: JobDefinitionConfig['schedule'];
    if (args.cronKind === 'at') {
        if (typeof args.atMs !== 'number') return 'cronKind="at" requires atMs (absolute epoch ms).';
        if (args.atMs <= Date.now()) return 'atMs must be in the future.';
        schedule = { kind: 'at', atMs: args.atMs };
    } else if (args.cronKind === 'every') {
        if (typeof args.everyMs !== 'number') return 'cronKind="every" requires everyMs (min 1000).';
        schedule = { kind: 'every', everyMs: args.everyMs };
    } else {
        if (!args.cronExpr) return 'cronKind="cron" requires cronExpr (5-field expression).';
        schedule = {
            kind: 'cron',
            expr: args.cronExpr,
            ...(args.cronTz ? { tz: args.cronTz } : {}),
        };
    }

    const id = `runtime-cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job: JobDefinitionConfig = {
        id,
        name: args.name ?? id,
        enabled: true,
        schedule,
        payload: {
            deliveryMode: args.deliveryMode ?? 'always',
            oneshot: args.oneshot ?? false,
            ...(args.prompt ? { message: args.prompt } : {}),
            ...(args.promptFile ? { promptFile: args.promptFile } : {}),
        },
        requires: [],
    };
    const ok = facade.addRuntimeCronJob(job, createdBy);
    if (!ok) return 'Failed to add cron job (engine not started?).';
    return `Cron job "${job.name}" created (id=${id}, kind=${args.cronKind}${job.payload.oneshot ? ', oneshot' : ''}).`;
}
