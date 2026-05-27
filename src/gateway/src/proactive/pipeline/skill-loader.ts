import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspace, createLogger } from '@flopsy/shared';

const log = createLogger('skill-loader');

/**
 * Resolve a skill name → SKILL.md path under the skills root, walking BOTH
 * flat (skills/<name>/SKILL.md) and grouped (skills/<group>/<name>/SKILL.md)
 * layouts. Returns null when not found.
 */
function findSkillPath(root: string, name: string): string | null {
    const flat = join(root, name, 'SKILL.md');
    if (existsSync(flat)) return flat;
    let groups: string[];
    try {
        groups = readdirSync(root);
    } catch {
        return null;
    }
    for (const group of groups) {
        const groupPath = join(root, group);
        try {
            if (!statSync(groupPath).isDirectory()) continue;
        } catch {
            continue;
        }
        const candidate = join(groupPath, name, 'SKILL.md');
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * One resolved skill — what the executor passes to the agent caller for
 * pre-loading into the proactive agent's system prompt.
 */
export interface PreloadedSkill {
    /** Skill directory name (the entry from `job.skills`). */
    readonly name: string;
    /** Full text of `<workspace>/skills/<name>/SKILL.md`. */
    readonly content: string;
}

/**
 * Resolve cron/heartbeat `job.skills` to SKILL.md file contents.
 *
 * Separates WHAT from HOW: the prompt is the task, the skill is the
 * recipe. Skills are framed as HOW-to-do authority, not new tools — the
 * executor
 * concatenates the returned `content` into a `<active_skills>` system-
 * prompt section before invoking the agent (see handler.invokeStateless).
 *
 * Failure semantics: missing skill → log.warn + skip (user decision —
 * the fire still runs without that skill). Read errors → same. We never
 * fail the fire for a bad skill reference; operator gets a warning they
 * can spot via `flopsy cron why <id>` or by grepping for `op:skill-load`
 * in gateway logs.
 *
 * Returns `{ loaded, missing }` so the executor can record both in audit:
 *   - loaded: array of resolved {name, content} pairs (passed to agent)
 *   - missing: array of skill names that couldn't be resolved (logged
 *     + surfaced in `flopsy cron why`)
 */
export async function loadSkills(
    skillNames: readonly string[] | undefined,
    jobId: string,
): Promise<{ loaded: PreloadedSkill[]; missing: string[] }> {
    if (!skillNames || skillNames.length === 0) {
        return { loaded: [], missing: [] };
    }

    const loaded: PreloadedSkill[] = [];
    const missing: string[] = [];

    for (const name of skillNames) {
        // Path containment: skill names must be plain directory names —
        // no slashes, no `..`, no absolute paths. A bad name shouldn't be
        // able to read `/etc/passwd` via traversal even though `existsSync`
        // would refuse such a path under the skills dir.
        if (
            name.includes('/') ||
            name.includes('\\') ||
            name === '.' ||
            name === '..' ||
            name.includes('\0')
        ) {
            log.warn(
                { jobId, name, op: 'skill-load' },
                'skill name contains path separators or traversal — refusing to load',
            );
            missing.push(name);
            continue;
        }

        const path = findSkillPath(workspace.skills(), name);
        if (!path) {
            log.warn(
                { jobId, name, op: 'skill-load' },
                'skill file not found (checked flat + grouped layouts) — fire will continue without it',
            );
            missing.push(name);
            continue;
        }

        try {
            const content = await readFile(path, 'utf-8');
            loaded.push({ name, content });
            log.debug(
                { jobId, name, bytes: content.length, op: 'skill-load' },
                'skill loaded',
            );
        } catch (err) {
            log.warn(
                {
                    jobId,
                    name,
                    path,
                    err: err instanceof Error ? err.message : String(err),
                    op: 'skill-load',
                },
                'skill read failed — fire will continue without it',
            );
            missing.push(name);
        }
    }

    return { loaded, missing };
}
