import type { CommandDef, CommandContext } from '../types';
import { getDndFacade } from '../dnd-facade';
import { panel, row, STATE } from '@flopsy/shared';

export const dndCommand: CommandDef = {
    name: 'dnd',
    aliases: ['quiet'],
    description: 'Toggle Do Not Disturb. `/dnd`, `/dnd 2h`, `/dnd off`.',
    handler: async (ctx: CommandContext) => {
        const facade = getDndFacade();
        if (!facade) {
            return {
                text: oneLine('DND', `${STATE.off}  proactive engine not running — DND has no effect`),
            };
        }

        const raw = ctx.rawArgs.trim();
        if (raw === '' || raw === 'status') {
            return { text: renderStatus(await facade.getStatus()) };
        }

        if (raw === 'off' || raw === 'clear') {
            await facade.clearDnd();
            return { text: oneLine('DND', `${STATE.ok}  cleared · proactive messages arrive normally`) };
        }

        if (raw.startsWith('quiet ')) {
            const timeStr = raw.slice(6).trim();
            const untilMs = parseClockTime(timeStr);
            if (untilMs === null) {
                return { text: oneLine('DND', `${STATE.warn}  couldn't parse "${timeStr}" — try /dnd quiet 22:00`) };
            }
            const snap = await facade.setQuietHours(untilMs);
            return { text: oneLine('DND', `${STATE.ok}  quiet hours until ${fmtTime(snap.untilMs!)}`) };
        }

        const match = raw.match(/^(\d+)\s*(s|m|h|d)\b(.*)$/);
        if (!match) {
            return {
                text: panel(
                    [
                        {
                            title: 'usage',
                            lines: [
                                row('/dnd 2h', '2-hour DND', 18),
                                row('/dnd 30m focus', 'with a reason label', 18),
                                row('/dnd off', 'clear', 18),
                                row('/dnd quiet 22:00', 'quiet until time', 18),
                            ],
                        },
                    ],
                    { header: `DND · couldn't parse "${raw}"` },
                ),
            };
        }
        const value = parseInt(match[1]!, 10);
        const unit = match[2]!;
        const reason = match[3]!.trim() || undefined;
        const ms =
            unit === 's' ? value * 1_000 :
            unit === 'm' ? value * 60_000 :
            unit === 'h' ? value * 3_600_000 :
            value * 86_400_000;
        const snap = await facade.setDnd(ms, reason);
        const reasonBit = snap.label ? ` (${snap.label})` : '';
        return {
            text: oneLine('DND', `${STATE.ok}  on for ${match[1]}${unit}${reasonBit} · ends ${fmtTime(snap.untilMs!)}`),
        };
    },
};

function renderStatus(s: {
    active: boolean;
    reason?: string;
    untilMs?: number;
    label?: string;
}): string {
    if (!s.active) {
        return oneLine('DND', `${STATE.off}  off · proactive messages arrive normally`);
    }
    const tag = s.reason === 'quiet hours' ? 'quiet hours' : 'DND';
    const labelBit = s.label ? ` (${s.label})` : '';
    const untilBit = s.untilMs ? ` until ${fmtTime(s.untilMs)}` : '';
    return oneLine('DND', `${STATE.on}  ${tag} on${labelBit}${untilBit}`);
}

function oneLine(title: string, value: string): string {
    return panel([{ title: '', lines: [row(title.toLowerCase(), value, 8)] }]);
}

function fmtTime(ms: number): string {
    return new Date(ms).toLocaleString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        month: 'short',
        day: 'numeric',
    });
}

/** Parse "22:00" → epoch-ms today (or tomorrow if already past). */
function parseClockTime(s: string): number | null {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hh = parseInt(m[1]!, 10);
    const mm = parseInt(m[2]!, 10);
    if (hh > 23 || mm > 59) return null;
    const target = new Date();
    target.setHours(hh, mm, 0, 0);
    if (target.getTime() <= Date.now()) {
        target.setDate(target.getDate() + 1);
    }
    return target.getTime();
}
