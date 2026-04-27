/**
 * `/dnd` — Do Not Disturb toggle from chat.
 *
 * Examples:
 *   /dnd                 → show current state
 *   /dnd off             → clear DND
 *   /dnd 2h              → enable DND for 2 hours
 *   /dnd 30m focus       → 30 min with a reason/label
 *   /dnd quiet 22:00     → quiet hours until 22:00 (today or tomorrow, whichever is later)
 *
 * When DND is active, proactive fires (heartbeats, cron, webhooks) are
 * suppressed. Cleared automatically when the window expires.
 */

import type { CommandDef, CommandContext } from '../types';
import { getDndFacade } from '../dnd-facade';

export const dndCommand: CommandDef = {
    name: 'dnd',
    aliases: ['quiet'],
    description: 'Toggle Do Not Disturb. `/dnd`, `/dnd 2h`, `/dnd off`.',
    handler: async (ctx: CommandContext) => {
        const facade = getDndFacade();
        if (!facade) {
            return {
                text: '_Proactive engine is not running — DND has no effect (nothing is firing anyway)._',
            };
        }

        const raw = ctx.rawArgs.trim();
        if (raw === '' || raw === 'status') {
            return { text: renderStatus(await facade.getStatus()) };
        }

        if (raw === 'off' || raw === 'clear') {
            await facade.clearDnd();
            return { text: '✅ DND cleared. Proactive messages will arrive normally.' };
        }

        if (raw.startsWith('quiet ')) {
            const timeStr = raw.slice(6).trim();
            const untilMs = parseClockTime(timeStr);
            if (untilMs === null) {
                return { text: `⚠️ Couldn't parse "${timeStr}". Try \`/dnd quiet 22:00\`.` };
            }
            const snap = await facade.setQuietHours(untilMs);
            return { text: `✅ Quiet hours set until ${fmtTime(snap.untilMs!)}.` };
        }

        // Duration form — `2h`, `30m focus`, `45m` etc.
        const match = raw.match(/^(\d+)\s*(s|m|h|d)\b(.*)$/);
        if (!match) {
            return {
                text:
                    `⚠️ Couldn't parse "${raw}". Try:\n` +
                    `• \`/dnd 2h\` — 2 hours\n` +
                    `• \`/dnd 30m focus\` — with reason\n` +
                    `• \`/dnd off\` — clear\n` +
                    `• \`/dnd quiet 22:00\` — quiet hours`,
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
            text: `✅ DND on for ${match[1]}${unit}${reasonBit}. Ends at ${fmtTime(snap.untilMs!)}.`,
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
        return '🟢 *DND off* — proactive messages arrive normally.';
    }
    const tag = s.reason === 'quiet hours' ? 'Quiet hours' : 'DND';
    const labelBit = s.label ? ` (${s.label})` : '';
    const untilBit = s.untilMs ? ` until ${fmtTime(s.untilMs)}` : '';
    return `🔕 *${tag} on*${labelBit}${untilBit}.`;
}

function fmtTime(ms: number): string {
    return new Date(ms).toLocaleString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        month: 'short',
        day: 'numeric',
    });
}

/**
 * Parse "22:00" → epoch-ms at that time today (or tomorrow if already past).
 */
function parseClockTime(s: string): number | null {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hh = parseInt(m[1]!, 10);
    const mm = parseInt(m[2]!, 10);
    if (hh > 23 || mm > 59) return null;
    const target = new Date();
    target.setHours(hh, mm, 0, 0);
    if (target.getTime() <= Date.now()) {
        target.setDate(target.getDate() + 1); // tomorrow
    }
    return target.getTime();
}
