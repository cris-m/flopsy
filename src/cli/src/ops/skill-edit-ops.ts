/**
 * Shared logic for `flopsy cron skill <verb>` and `flopsy heartbeat skill <verb>`.
 *
 * The mgmt API exposes only a REPLACE endpoint (POST /management/schedule/<id>/skills)
 * because the bookkeeping is simpler there — the engine always writes the full
 * array, no need to coordinate add/remove races. So the CLI reads the current
 * array, computes the new one client-side, and ships the replacement.
 *
 * Both cron-command.ts and heartbeat-command.ts wire to these helpers. The
 * only difference between cron and heartbeat is the storage shape:
 *   - heartbeat: skills array sits at config root
 *   - cron: skills array sits under config.payload
 * `currentSkills` handles both.
 */

import { bad, dim } from '../ui/pretty';
import {
    loadSchedulesOfKind,
    managementSetSkills,
    parseConfig,
    type ScheduleKind,
} from './schedule-client';

/** Locate the runtime schedule row by id, scoped to a kind. Returns null if
 *  the DB is offline, the schedule doesn't exist, or the kind doesn't match. */
function findRow(kind: ScheduleKind, id: string): {
    configJson: string;
} | null {
    const all = loadSchedulesOfKind(kind);
    if (!all) return null;
    const row = all.find((r) => r.id === id);
    return row ? { configJson: row.configJson } : null;
}

/** Read the live `skills` array from the on-disk DB. Returns empty array
 *  when the field is absent, malformed, or contains non-strings. */
export function currentSkills(kind: ScheduleKind, id: string): string[] | null {
    const row = findRow(kind, id);
    if (!row) return null;
    const config = parseConfig({ configJson: row.configJson } as never);
    const raw = kind === 'heartbeat'
        ? config['skills']
        : (config['payload'] as Record<string, unknown> | undefined)?.['skills'];
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

function notFound(kind: ScheduleKind, id: string): void {
    console.log(bad(`No ${kind} with id "${id}"`));
    console.log(dim(`  Run \`flopsy ${kind === 'heartbeat' ? 'heartbeat' : 'cron'} list\` to see ids.`));
}

export async function skillList(kind: ScheduleKind, id: string): Promise<void> {
    const skills = currentSkills(kind, id);
    if (skills === null) return notFound(kind, id);
    if (skills.length === 0) {
        console.log(dim(`No skills bound to ${id}.`));
        return;
    }
    console.log(`Skills bound to ${id}:`);
    for (const s of skills) console.log(`  - ${s}`);
}

export async function skillAdd(kind: ScheduleKind, id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
        console.log(bad('skill name cannot be empty'));
        process.exit(1);
    }
    const skills = currentSkills(kind, id);
    if (skills === null) return notFound(kind, id);
    if (skills.includes(trimmed)) {
        console.log(dim(`${trimmed} already bound to ${id} — no change.`));
        return;
    }
    await managementSetSkills(id, [...skills, trimmed]);
}

export async function skillRemove(kind: ScheduleKind, id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
        console.log(bad('skill name cannot be empty'));
        process.exit(1);
    }
    const skills = currentSkills(kind, id);
    if (skills === null) return notFound(kind, id);
    if (!skills.includes(trimmed)) {
        console.log(dim(`${trimmed} was not bound to ${id} — no change.`));
        return;
    }
    await managementSetSkills(id, skills.filter((s) => s !== trimmed));
}

export async function skillClear(kind: ScheduleKind, id: string): Promise<void> {
    const skills = currentSkills(kind, id);
    if (skills === null) return notFound(kind, id);
    if (skills.length === 0) {
        console.log(dim(`${id} has no skills bound — no change.`));
        return;
    }
    await managementSetSkills(id, []);
}

/** Apply `--clear-skills` / `--add-skill` / `--remove-skill` / `--skill`
 *  flags in order: clear → set → add → remove. */
export function composeSkillEdit(
    current: string[],
    ops: {
        clearAll?: boolean;
        replace?: string[];
        addSkills?: string[];
        removeSkills?: string[];
    },
): string[] {
    let base: string[];
    if (ops.replace) {
        base = ops.replace.slice();
    } else if (ops.clearAll) {
        base = [];
    } else {
        base = current.slice();
    }
    const seen = new Set(base);
    for (const s of ops.addSkills ?? []) {
        const trimmed = s.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        base.push(trimmed);
    }
    const drop = new Set((ops.removeSkills ?? []).map((s) => s.trim()).filter(Boolean));
    return base.filter((s) => !drop.has(s));
}

/** Used by `flopsy cron edit <id>` and `flopsy heartbeat edit <id>`. Reads
 *  current, applies the ops, sends a single REPLACE to the mgmt API. Prints
 *  a no-op message when the result equals the current set. */
export async function editSkills(
    kind: ScheduleKind,
    id: string,
    ops: {
        clearAll?: boolean;
        replace?: string[];
        addSkills?: string[];
        removeSkills?: string[];
    },
): Promise<void> {
    const current = currentSkills(kind, id);
    if (current === null) return notFound(kind, id);
    const next = composeSkillEdit(current, ops);
    if (next.length === current.length && next.every((v, i) => v === current[i])) {
        console.log(dim(`${id}: no change.`));
        return;
    }
    await managementSetSkills(id, next);
}
