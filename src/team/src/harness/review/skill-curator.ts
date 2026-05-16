/**
 * SkillCurator — async sweeper that auto-manages skill lifecycle state.
 *
 * Runs at session-close time (non-blocking, best-effort). Only touches
 * agent-created skills (`is_agent_created: true`). Bundled / hand-crafted
 * skills are never auto-archived.
 *
 * Transitions:
 *   active  → stale    when last_viewed_at is older than STALE_AFTER_DAYS and
 *                       the skill has not been pinned
 *   stale   → archived when last_viewed_at is older than ARCHIVE_AFTER_DAYS
 *
 * A skill transitions back active→stale→active automatically when the agent
 * reads it (view sets state = 'active' if it was stale). This means the
 * curator is NOT destructive — it only adjusts catalog visibility.
 */

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@flopsy/shared';
import type { SkillUsageStore, SkillUsageRecord } from './skill-usage-store';

const log = createLogger('skill-curator');

/** Days of no reads before a skill becomes stale. */
const STALE_AFTER_DAYS = 30;
/** Days of no reads before a stale skill is archived. */
const ARCHIVE_AFTER_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CuratorResult {
    markedStale: string[];
    markedArchived: string[];
}

/**
 * Run a single curator pass over all agent-created skills.
 * Returns a summary of what changed (empty arrays if nothing changed).
 */
export function runSkillCurator(
    skillsPath: string,
    store: SkillUsageStore,
    now: number = Date.now(),
): CuratorResult {
    const result: CuratorResult = { markedStale: [], markedArchived: [] };

    const allRecords = store.loadAll();
    const onDiskNames = getSkillNamesOnDisk(skillsPath);

    for (const name of Object.keys(allRecords)) {
        const rec = allRecords[name];
        if (!rec) continue;

        // Only manage agent-created skills; never touch pinned skills.
        if (!rec.is_agent_created || rec.pinned) continue;

        // Already archived — nothing more to do.
        if (rec.state === 'archived') continue;

        // Skip if the skill file doesn't exist on disk (may have been manually deleted).
        if (!onDiskNames.has(name)) continue;

        const lastUsed = rec.last_viewed_at ? Date.parse(rec.last_viewed_at) : Date.parse(rec.created_at);
        const daysSinceUse = (now - lastUsed) / MS_PER_DAY;

        if (daysSinceUse >= ARCHIVE_AFTER_DAYS && rec.state === 'stale') {
            store.setState(name, 'archived');
            result.markedArchived.push(name);
            log.info(
                { name, daysSinceUse: Math.round(daysSinceUse), threshold: ARCHIVE_AFTER_DAYS },
                'curator: archived stale skill',
            );
        } else if (daysSinceUse >= STALE_AFTER_DAYS && rec.state === 'active') {
            store.setState(name, 'stale');
            result.markedStale.push(name);
            log.info(
                { name, daysSinceUse: Math.round(daysSinceUse), threshold: STALE_AFTER_DAYS },
                'curator: marked skill stale',
            );
        }
    }

    return result;
}

function getSkillNamesOnDisk(skillsPath: string): Set<string> {
    if (!existsSync(skillsPath)) return new Set();
    try {
        return new Set(
            readdirSync(skillsPath, { withFileTypes: true })
                .filter((e) => e.isDirectory() && e.name !== 'proposed')
                .map((e) => e.name),
        );
    } catch {
        return new Set();
    }
}
