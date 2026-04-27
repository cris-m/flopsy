/**
 * `flopsy dnd` — toggle Do Not Disturb on the running gateway.
 *
 * Mirrors the `/dnd` slash command. Talks to the mgmt HTTP endpoint so
 * the change takes effect on the live engine without a restart.
 *
 *   flopsy dnd                → show current state
 *   flopsy dnd on --for 2h    → enable DND for 2 hours
 *   flopsy dnd on --for 30m --reason focus
 *   flopsy dnd off            → clear
 *   flopsy dnd quiet --until 22:00
 */

import { Command } from 'commander';
import { bad, detail, ok, section } from '../ui/pretty';
import { mgmtFetchJson } from './schedule-client';

export function registerDndCommand(root: Command): void {
    const dnd = root
        .command('dnd')
        .description('Manage Do Not Disturb — pauses proactive messages')
        .alias('quiet');

    dnd.command('status', { isDefault: true })
        .description('Show current DND state')
        .action(async () => {
            const status = await mgmtFetchJson<DndSnapshot>('GET', '/mgmt/dnd');
            if (!status) process.exit(1);
            if (!status.active) {
                console.log(ok('DND off — proactive messages arrive normally.'));
                return;
            }
            console.log(section(`DND on — ${status.reason ?? 'dnd'}`));
            if (status.label) console.log(detail('label', status.label));
            if (status.untilMs) console.log(detail('until', new Date(status.untilMs).toISOString()));
        });

    dnd.command('on')
        .description('Enable DND for a duration')
        .requiredOption('--for <duration>', '"30s" | "5m" | "2h" | "1d"')
        .option('--reason <text>', 'Short label shown in status (e.g. "meeting")')
        .action(async (opts: { for: string; reason?: string }) => {
            const ms = parseDuration(opts.for);
            if (ms === null) {
                console.log(bad(`Couldn't parse --for "${opts.for}". Use "30m", "2h", etc.`));
                process.exit(1);
            }
            const snap = await mgmtFetchJson<DndSnapshot>('POST', '/mgmt/dnd/on', {
                durationMs: ms,
                reason: opts.reason,
            });
            if (!snap) process.exit(1);
            const reasonBit = snap.label ? ` (${snap.label})` : '';
            console.log(
                ok(
                    `DND on for ${opts.for}${reasonBit}. Ends at ${new Date(snap.untilMs!).toISOString()}`,
                ),
            );
        });

    dnd.command('off')
        .description('Clear DND immediately')
        .action(async () => {
            const r = await mgmtFetchJson<{ ok?: boolean; message?: string }>(
                'POST',
                '/mgmt/dnd/off',
                {},
            );
            if (!r) process.exit(1);
            console.log(ok(r.message ?? 'DND cleared.'));
        });

    dnd.command('quiet')
        .description('Set quiet-hours window until a specific time')
        .requiredOption('--until <HH:MM>', '24-hour time in local zone (e.g. "22:00")')
        .action(async (opts: { until: string }) => {
            const untilMs = parseClockTime(opts.until);
            if (untilMs === null) {
                console.log(bad(`Couldn't parse --until "${opts.until}". Use 24-hour format like "22:00".`));
                process.exit(1);
            }
            const snap = await mgmtFetchJson<DndSnapshot>('POST', '/mgmt/dnd/quiet', { untilMs });
            if (!snap) process.exit(1);
            console.log(ok(`Quiet hours until ${new Date(snap.untilMs!).toLocaleString()}`));
        });
}

interface DndSnapshot {
    active: boolean;
    reason?: string;
    untilMs?: number;
    label?: string;
}

function parseDuration(s: string): number | null {
    const m = s.match(/^(\d+)\s*(s|m|h|d)$/);
    if (!m) return null;
    const value = parseInt(m[1]!, 10);
    switch (m[2]) {
        case 's': return value * 1_000;
        case 'm': return value * 60_000;
        case 'h': return value * 3_600_000;
        case 'd': return value * 86_400_000;
        default:  return null;
    }
}

function parseClockTime(s: string): number | null {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hh = parseInt(m[1]!, 10);
    const mm = parseInt(m[2]!, 10);
    if (hh > 23 || mm > 59) return null;
    const target = new Date();
    target.setHours(hh, mm, 0, 0);
    // Next occurrence: if today's HH:MM has already passed, roll forward a day.
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    return target.getTime();
}
