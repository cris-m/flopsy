import type { CommandDef, CommandContext } from '../types';
import { getPersonalityFacade } from '../personality-facade';
import { panel, row, STATE } from '@flopsy/shared';

const CLEAR_ALIASES = new Set(['default', 'reset', 'off', 'clear', 'none']);

export const personalityCommand: CommandDef = {
    name: 'personality',
    aliases: ['persona', 'voice'],
    description: 'Switch the agent voice for this session. `/personality`, `/personality concise`, `/personality reset`.',
    handler: async (ctx: CommandContext): Promise<{ text: string } | null> => {
        const facade = getPersonalityFacade();
        if (!facade) {
            return {
                text: panel(
                    [{ title: '', lines: [row('personality', `${STATE.warn}  not wired (no personalities.yaml or empty registry)`, 12)] }],
                ),
            };
        }

        const arg = ctx.rawArgs.trim().toLowerCase();
        const list = facade.list();
        const active = facade.getActive(ctx.threadId);

        if (arg === '' || arg === 'list' || arg === 'status') {
            return { text: renderList(list, active) };
        }

        if (CLEAR_ALIASES.has(arg)) {
            if (!active) {
                return {
                    text: oneLine('PERSONALITY', `${STATE.ok}  already on default voice (no overlay set)`),
                };
            }
            const ok = facade.setActive(ctx.threadId, null);
            if (!ok) {
                return {
                    text: oneLine('PERSONALITY', `${STATE.fail}  could not clear (no active session for this peer)`),
                };
            }
            facade.evictThread(ctx.threadId);
            return {
                text: oneLine('PERSONALITY', `${STATE.ok}  cleared · back to default voice on the next message`),
            };
        }

        const target = list.find((p) => p.name === arg);
        if (!target) {
            return { text: renderUnknown(arg, list) };
        }

        if (active === target.name) {
            return {
                text: oneLine('PERSONALITY', `${STATE.ok}  already on "${target.name}" — nothing to change`),
            };
        }

        const ok = facade.setActive(ctx.threadId, target.name);
        if (!ok) {
            return {
                text: oneLine('PERSONALITY', `${STATE.fail}  could not switch (no active session for this peer)`),
            };
        }
        facade.evictThread(ctx.threadId);

        return {
            text: panel(
                [
                    {
                        title: 'personality',
                        lines: [
                            row('status', `${STATE.ok}  switched to "${target.name}"`, 12),
                            row('voice', target.description, 12),
                            row('applies', 'starting on the next message', 12),
                            row('reset', '/personality reset', 12),
                        ],
                    },
                ],
                { header: 'PERSONALITY' },
            ),
        };
    },
};

function renderList(
    list: ReadonlyArray<{ name: string; description: string }>,
    active: string | null,
): string {
    if (list.length === 0) {
        return oneLine('PERSONALITY', `${STATE.warn}  no personalities configured · drop entries into personalities.yaml and restart`);
    }
    const lines = [row('active', active ? `"${active}"` : 'default (plain SOUL.md voice)', 12)];
    lines.push(row('— available —', '', 12));
    for (const p of list) {
        const marker = active === p.name ? '●' : '○';
        lines.push(row(`${marker} ${p.name}`, p.description, 12));
    }
    lines.push(row('— commands —', '', 12));
    lines.push(row('switch', '/personality <name>', 12));
    lines.push(row('clear', '/personality reset', 12));
    return panel([{ title: 'personality', lines }], { header: 'PERSONALITY' });
}

function renderUnknown(
    name: string,
    list: ReadonlyArray<{ name: string; description: string }>,
): string {
    const lines = [
        row('error', `${STATE.fail}  no personality named "${name}"`, 12),
        row('— available —', '', 12),
    ];
    for (const p of list) lines.push(row(p.name, p.description, 12));
    return panel([{ title: 'personality', lines }], { header: 'PERSONALITY' });
}

function oneLine(header: string, line: string): string {
    return panel([{ title: '', lines: [row('personality', line, 12)] }], { header });
}
