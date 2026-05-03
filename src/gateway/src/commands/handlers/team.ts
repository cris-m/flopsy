import { panel, row, STATE, agoLabel, truncate } from '@flopsy/shared';
import type { CommandDef, CommandContext, TeamMemberSummary } from '../types';
import type { PanelSection } from '@flopsy/shared';

export const teamCommand: CommandDef = {
    name: 'team',
    aliases: ['t', 'roster'],
    description: 'Show the team roster and what each worker is doing.',
    handler: async (ctx: CommandContext) => {
        const team = ctx.threadStatus?.team;
        if (!team || team.length === 0) {
            return {
                text: panel(
                    [{ title: 'team', lines: [row('', '(no team configured for this thread yet)')] }],
                    { header: 'TEAM' },
                ),
            };
        }
        return { text: render(ctx.threadStatus?.entryAgent, team) };
    },
};

function render(entryAgent: string | undefined, team: readonly TeamMemberSummary[]): string {
    const enabled = team.filter((m) => m.enabled);
    const working = enabled.filter((m) => m.status === 'running');
    const idle = enabled.filter((m) => m.status === 'idle');

    const summary = [
        'TEAM',
        entryAgent ? `leader ${entryAgent}` : null,
        `${enabled.length}/${team.length} enabled`,
        `${working.length} working`,
        `${idle.length} idle`,
    ]
        .filter(Boolean)
        .join(' · ');

    const sections: PanelSection[] = [];
    sections.push({ title: 'roster', lines: enabled.map(memberRow) });

    const disabled = team.filter((m) => !m.enabled);
    if (disabled.length > 0) {
        sections.push({
            title: 'disabled',
            lines: [row('', disabled.map((m) => m.name).join(', '))],
        });
    }

    return panel(sections, { header: summary });
}

function memberRow(m: TeamMemberSummary): string {
    let value: string;
    if (m.status === 'running' && m.currentTask) {
        value = `${STATE.on}  working · "${truncate(m.currentTask.description, 40)}"`;
    } else if (m.status === 'running') {
        value = `${STATE.on}  working`;
    } else {
        const ago =
            m.lastActiveAt !== undefined
                ? ` · last ${agoLabel(Date.now() - m.lastActiveAt)}`
                : '';
        value = `${STATE.off}  idle${ago}`;
    }
    return row(m.name, value, 14);
}
