import type { CommandResult } from '../types';
import {
    getScheduleFacade,
    type ScheduleKind,
    type ScheduleRowSnapshot,
} from '../schedule-facade';
import { panel, row, STATE } from '@flopsy/shared';

const VERB_LIST = ['tick', 'list', 'show', 'disable', 'enable', 'remove', 'status', 'trigger', 'fires'] as const;
type Verb = (typeof VERB_LIST)[number];

function headerFor(kind: ScheduleKind): string {
    return kind === 'heartbeat' ? 'HEARTBEAT' : 'CRON';
}

function cmdFor(kind: ScheduleKind): string {
    return kind === 'heartbeat' ? '/heartbeat' : '/cron';
}

function usage(kind: ScheduleKind): string {
    const cmd = cmdFor(kind);
    return panel(
        [
            {
                title: 'verbs',
                lines: [
                    row('list', 'show all enabled + disabled', 10),
                    row('show', `${cmd} show <id>`, 10),
                    row('status', `${cmd} status [id]`, 10),
                    row('enable', `${cmd} enable <id> · disable <id>`, 10),
                    row('trigger', `${cmd} trigger <id> · tick (sweep)`, 10),
                    row('remove', `${cmd} remove <id>`, 10),
                    row('fires', `${cmd} fires <id>`, 10),
                ],
            },
        ],
        { header: `${headerFor(kind)} · usage` },
    );
}

function unavailable(kind: ScheduleKind): CommandResult {
    return {
        text: panel(
            [{ title: '', lines: [row('engine', `${STATE.off}  proactive engine not running`, 10)] }],
            { header: headerFor(kind) },
        ),
    };
}

function renderListLine(r: ScheduleRowSnapshot): string {
    const state = r.enabled ? STATE.ok : STATE.off;
    const sched = r.intervalOrCron ? ` (${r.intervalOrCron})` : '';
    const skills = r.skills && r.skills.length > 0 ? ` · skills: ${r.skills.join(', ')}` : '';
    const label = r.name && r.name !== r.id ? r.name : r.id;
    return `${state}  ${label}${sched}${skills}`;
}

function renderList(rows: readonly ScheduleRowSnapshot[], kind: ScheduleKind): string {
    const cmd = cmdFor(kind);
    if (rows.length === 0) {
        return panel(
            [{ title: '', lines: [row('count', `0 ${kind}s · add via \`flopsy ${kind} add\``, 10)] }],
            { header: headerFor(kind) },
        );
    }
    const enabled = rows.filter((r) => r.enabled).length;
    const enabledRows = rows.filter((r) => r.enabled);
    const disabledRows = rows.filter((r) => !r.enabled);
    const sections = [];
    if (enabledRows.length > 0) {
        sections.push({ title: 'active', lines: enabledRows.map(renderListLine) });
    }
    if (disabledRows.length > 0) {
        sections.push({ title: 'disabled', lines: disabledRows.map(renderListLine) });
    }
    return panel(sections, { header: `${headerFor(kind)} · ${enabled}/${rows.length} enabled` });
}

function findRow(
    rows: readonly ScheduleRowSnapshot[],
    id: string,
): ScheduleRowSnapshot | undefined {
    return rows.find((r) => r.id === id);
}

export async function runScheduleCommand(
    kind: ScheduleKind,
    args: string[],
): Promise<CommandResult> {
    const facade = getScheduleFacade();
    if (!facade) return unavailable(kind);

    const verb = (args[0] ?? '').toLowerCase() as Verb;
    if (!verb || !VERB_LIST.includes(verb as Verb)) {
        return { text: usage(kind) };
    }

    // No-id verbs first
    if (verb === 'list') {
        return { text: renderList(facade.list(kind), kind) };
    }
    if (verb === 'tick') {
        const res = facade.tick(kind);
        if (!res.ok || res.dispatched.length === 0) {
            return {
                text: panel(
                    [{ title: '', lines: [row('tick', `${STATE.warn}  dispatched nothing (no enabled ${kind}s)`, 10)] }],
                    { header: headerFor(kind) },
                ),
            };
        }
        return {
            text: panel(
                [
                    {
                        title: 'tick',
                        lines: [
                            row('dispatched', `${STATE.ok}  ${res.dispatched.length} schedule${res.dispatched.length === 1 ? '' : 's'}`, 12),
                            ...res.dispatched.map((d) => row('', `· ${d}`, 12)),
                        ],
                    },
                ],
                { header: headerFor(kind) },
            ),
        };
    }
    if (verb === 'status') {
        // No id: summarize counts. With id: same as `show`.
        if (args[1]) {
            return runShow(kind, args[1], facade);
        }
        const rows = facade.list(kind);
        const enabled = rows.filter((r) => r.enabled).length;
        const withSkills = rows.filter((r) => r.skills && r.skills.length > 0).length;
        return {
            text: panel(
                [
                    {
                        title: 'status',
                        lines: [
                            row('total', String(rows.length), 12),
                            row('enabled', `${enabled}/${rows.length}`, 12),
                            row('w/ skills', String(withSkills), 12),
                        ],
                    },
                ],
                { header: headerFor(kind) },
            ),
        };
    }

    // The remaining verbs need an id
    const id = args[1];
    if (!id) {
        return {
            text: panel(
                [{ title: '', lines: [row('error', `${STATE.warn}  \`${verb}\` requires an id — see ${cmdFor(kind)} list`, 10)] }],
                { header: headerFor(kind) },
            ),
        };
    }

    if (verb === 'show') return runShow(kind, id, facade);

    if (verb === 'enable' || verb === 'disable') {
        const res = facade.setEnabled(id, verb === 'enable');
        return ackResult(kind, res);
    }
    if (verb === 'trigger') {
        const res = await facade.trigger(id);
        return ackResult(kind, res);
    }
    if (verb === 'remove') {
        const res = facade.remove(id);
        return ackResult(kind, res);
    }
    if (verb === 'fires') {
        // Slash output kept lean — the CLI's `flopsy <kind> why <id>` shows
        // the full fire detail. Slash returns the most recent few delivery
        // outcomes via the existing dedup store. We don't have a direct
        // facade hook for this yet, so emit a redirect rather than a
        // half-baked render.
        return {
            text: panel(
                [
                    {
                        title: 'fires',
                        lines: [
                            row('hint', `${STATE.warn}  slash render not yet wired`, 10),
                            row('CLI', `flopsy ${kind} fires ${id}`, 10),
                        ],
                    },
                ],
                { header: headerFor(kind) },
            ),
        };
    }

    return { text: usage(kind) };
}

function ackResult(kind: ScheduleKind, res: { ok: boolean; message?: string }): CommandResult {
    const glyph = res.ok ? STATE.ok : STATE.fail;
    return {
        text: panel(
            [{ title: '', lines: [row(res.ok ? 'ok' : 'fail', `${glyph}  ${res.message ?? (res.ok ? 'done' : 'failed')}`, 10)] }],
            { header: headerFor(kind) },
        ),
    };
}

function runShow(kind: ScheduleKind, id: string, facade: NonNullable<ReturnType<typeof getScheduleFacade>>): CommandResult {
    const r = findRow(facade.list(kind), id);
    if (!r) {
        return {
            text: panel(
                [{ title: '', lines: [row('error', `${STATE.fail}  no ${kind} with id "${id}"`, 10)] }],
                { header: headerFor(kind) },
            ),
        };
    }
    const lines: string[] = [];
    lines.push(row('id', r.id, 10));
    if (r.name && r.name !== r.id) lines.push(row('name', r.name, 10));
    if (r.intervalOrCron) lines.push(row('schedule', r.intervalOrCron, 10));
    lines.push(row('enabled', r.enabled ? `${STATE.ok} yes` : `${STATE.off} no`, 10));
    lines.push(
        row(
            'skills',
            r.skills && r.skills.length > 0 ? r.skills.join(', ') : '(none bound)',
            10,
        ),
    );
    return {
        text: panel([{ title: 'detail', lines }], { header: headerFor(kind) }),
    };
}
