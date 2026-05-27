import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@flopsy/shared';
import type { SkillUsageStore, SkillUsageRecord } from './skill-usage-store';
import { patchSkillFile } from './skill-writer';

const log = createLogger('skill-curator');

const VALIDATION_MIN_HOURS = 24;
const VALIDATION_MIN_FIRES = 8;
// reject if post-edit reply rate fell more than this (absolute) below baseline
const VALIDATION_DEGRADE_MARGIN = 0.1;

export interface ProactiveEngagementSource {
    getProactiveEngagement(sinceMs: number, untilMs?: number): { delivered: number; replied: number };
}

export interface ValidationResult {
    accepted: string[];
    rejected: string[];
    stillPending: string[];
}

// Only `proactive` is gated — the one fire type with a measurable engagement signal.
export async function validatePendingEdits(
    skillsPath: string,
    store: SkillUsageStore,
    engagement: ProactiveEngagementSource,
    skillNames: readonly string[] = ['proactive'],
    now: number = Date.now(),
): Promise<ValidationResult> {
    const result: ValidationResult = { accepted: [], rejected: [], stillPending: [] };
    for (const name of skillNames) {
        const edit = store.getPendingEdit(name);
        if (!edit) continue;

        const ageHours = (now - edit.appliedAt) / (60 * 60 * 1000);
        if (ageHours < VALIDATION_MIN_HOURS) {
            result.stillPending.push(name);
            continue;
        }
        const post = engagement.getProactiveEngagement(edit.appliedAt, now);
        if (post.delivered < VALIDATION_MIN_FIRES) {
            result.stillPending.push(name);
            continue;
        }
        const postRate = post.replied / post.delivered;

        if (postRate + VALIDATION_DEGRADE_MARGIN < edit.baselineRate) {
            let reverted = true;
            for (const bullet of edit.bullets) {
                try {
                    const r = await patchSkillFile(skillsPath, name, `- ${bullet}`, '', 1);
                    if (!r.ok) reverted = false;
                } catch {
                    reverted = false;
                }
            }
            for (const fp of edit.fingerprints) store.addRejectedEdit(name, fp);
            store.clearPendingEdit(name);
            result.rejected.push(name);
            log.info(
                { name, baselineRate: edit.baselineRate, postRate: Number(postRate.toFixed(2)), n: post.delivered, reverted },
                'curator: reverted skill edit that hurt engagement',
            );
        } else {
            store.clearPendingEdit(name);
            result.accepted.push(name);
            log.info(
                { name, baselineRate: edit.baselineRate, postRate: Number(postRate.toFixed(2)), n: post.delivered },
                'curator: accepted validated skill edit',
            );
        }
    }
    return result;
}

const STALE_AFTER_DAYS = 30;
const ARCHIVE_AFTER_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CuratorResult {
    markedStale: string[];
    markedArchived: string[];
}

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
        if (!rec.is_agent_created || rec.pinned) continue;
        if (rec.state === 'archived') continue;
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
                .filter((e) => e.isDirectory())
                .map((e) => e.name),
        );
    } catch {
        return new Set();
    }
}
