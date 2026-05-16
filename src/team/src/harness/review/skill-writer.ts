import { writeFile, rename, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { createLogger } from '@flopsy/shared';

const log = createLogger('skill-writer');

/**
 * Resolve the paths for a skill inside the skills directory.
 *
 * The `skills()` interceptor in flopsygraph expects the structure:
 *   <skillsPath>/<skillName>/SKILL.md
 *
 * It validates that the frontmatter `name` field EXACTLY matches the directory
 * name. If they diverge, the interceptor silently drops the skill.
 */
function skillPaths(skillsPath: string, skillName: string) {
    const dir = join(skillsPath, skillName);
    const file = join(dir, 'SKILL.md');
    return { dir, file };
}

/**
 * Ensure the frontmatter `name:` field in a SKILL.md body matches
 * the directory name (required by the flopsygraph skills() interceptor).
 * If the field is missing or wrong, it is inserted/replaced.
 */
function ensureNameField(content: string, skillName: string): string {
    // If there's no frontmatter at all, prepend minimal one.
    if (!content.startsWith('---')) {
        return `---\nname: ${skillName}\n---\n\n${content}`;
    }

    const closeIdx = content.indexOf('\n---', 3);
    if (closeIdx === -1) return content;

    const fmBody = content.slice(3, closeIdx);

    const nameLineRe = /^name:.*$/m;
    const newFm = nameLineRe.test(fmBody)
        ? fmBody.replace(nameLineRe, `name: ${skillName}`)
        : `\nname: ${skillName}${fmBody}`;

    return `---${newFm}${content.slice(closeIdx)}`;
}

/**
 * Atomically write a new skill to `<skillsPath>/<skillName>/SKILL.md`.
 *
 * - Creates the subdirectory if needed.
 * - Ensures the frontmatter `name` field matches the directory name.
 * - Skips (returns false) if the file already exists — human-edited skills
 *   are never overwritten; the background reviewer may surface the same
 *   pattern twice but only the first write wins.
 * - Uses write-to-tmp + rename so the skills() interceptor never reads a
 *   partial file during a directory scan.
 */
export async function writeSkillFile(
    skillsPath: string,
    skillName: string,
    content: string,
): Promise<boolean> {
    const { dir, file: destPath } = skillPaths(skillsPath, skillName);

    if (existsSync(destPath)) {
        log.debug({ skillName, path: destPath }, 'skill already exists — skipping write');
        return false;
    }

    await mkdir(dir, { recursive: true });

    const normalizedContent = ensureNameField(content, skillName);
    const tmpPath = `${destPath}.tmp`;
    try {
        await writeFile(tmpPath, normalizedContent, 'utf-8');
        await rename(tmpPath, destPath);
        log.info({ skillName, path: destPath }, 'skill written');
        return true;
    } catch (err) {
        try { await (await import('fs/promises')).unlink(tmpPath); } catch { /* ignored */ }
        throw err;
    }
}

/** Cap on bullet count in a `## Lessons Learned` section. Newest wins
 * (oldest bullets at the top are pruned). Keeps skills scannable when
 * the self-improve heartbeat fires every 4h and could otherwise grow
 * the section unboundedly. */
const MAX_LESSONS_PER_SKILL = 20;

/**
 * Append bullet points to the `## Lessons Learned` section of an existing skill.
 * Creates the section at the end of the file if it doesn't exist yet.
 * Returns false if the skill directory/file doesn't exist.
 *
 * After append, the section is capped at MAX_LESSONS_PER_SKILL bullets —
 * oldest entries (top of section) are pruned. This is the only invariant
 * change to existing callers; if you need the full append-only history,
 * remove or raise the cap.
 */
export async function appendLessonsToSkill(
    skillsPath: string,
    skillName: string,
    lessons: string[],
): Promise<boolean> {
    if (lessons.length === 0) return false;
    const { file: destPath } = skillPaths(skillsPath, skillName);

    if (!existsSync(destPath)) {
        log.debug({ skillName }, 'skill file not found — cannot append lessons');
        return false;
    }

    const existing = await readFile(destPath, 'utf-8');
    let updated: string;

    const LESSONS_HEADER = '## Lessons Learned';
    const headerIdx = existing.indexOf(LESSONS_HEADER);

    if (headerIdx === -1) {
        const capped = lessons.slice(-MAX_LESSONS_PER_SKILL);
        const newLines = capped.map((l) => `- ${l}`).join('\n');
        updated = `${existing.trimEnd()}\n\n${LESSONS_HEADER}\n${newLines}\n`;
    } else {
        // Existing section: parse current bullets, append new ones, cap.
        // Section spans from after the header line to the next H2 (or EOF).
        const sectionStart = headerIdx + LESSONS_HEADER.length;
        const afterHeader = existing.indexOf('\n## ', headerIdx + 1);
        const sectionEnd = afterHeader === -1 ? existing.length : afterHeader;
        const sectionBody = existing.slice(sectionStart, sectionEnd);

        const existingBullets = sectionBody
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('- '))
            .map((line) => line.slice(2));

        // Newest wins: existing bullets first (older), new lessons last,
        // then keep the trailing MAX_LESSONS_PER_SKILL.
        const combined = [...existingBullets, ...lessons];
        const capped = combined.slice(-MAX_LESSONS_PER_SKILL);
        const newSection = '\n' + capped.map((l) => `- ${l}`).join('\n') + '\n';

        updated = existing.slice(0, sectionStart) + newSection + existing.slice(sectionEnd);
    }

    const tmpPath = `${destPath}.tmp`;
    try {
        await writeFile(tmpPath, updated, 'utf-8');
        await rename(tmpPath, destPath);
        log.info({ skillName, lessons: lessons.length }, 'lessons appended to skill');
        return true;
    } catch (err) {
        try { await (await import('fs/promises')).unlink(tmpPath); } catch { /* ignored */ }
        throw err;
    }
}

/**
 * Update (or add) the `version` field in the YAML frontmatter of an existing skill.
 * Returns false if the skill directory/file doesn't exist.
 */
export async function bumpSkillVersion(
    skillsPath: string,
    skillName: string,
    version: string,
): Promise<boolean> {
    const { file: destPath } = skillPaths(skillsPath, skillName);

    if (!existsSync(destPath)) {
        log.debug({ skillName }, 'skill file not found — cannot bump version');
        return false;
    }

    const existing = await readFile(destPath, 'utf-8');
    const fmMatch = existing.match(/^---\n([\s\S]*?)\n---/);
    let updated: string;

    if (!fmMatch) {
        updated = `---\nname: ${skillName}\nversion: ${version}\n---\n\n${existing}`;
    } else {
        const fmBody = fmMatch[1]!;
        const newFm = /^version:/m.test(fmBody)
            ? fmBody.replace(/^version:.*$/m, `version: ${version}`)
            : `${fmBody}\nversion: ${version}`;
        updated = existing.replace(fmMatch[0], `---\n${newFm}\n---`);
    }

    const tmpPath = `${destPath}.tmp`;
    try {
        await writeFile(tmpPath, updated, 'utf-8');
        await rename(tmpPath, destPath);
        log.info({ skillName, version }, 'skill version bumped');
        return true;
    } catch (err) {
        try { await (await import('fs/promises')).unlink(tmpPath); } catch { /* ignored */ }
        throw err;
    }
}

/**
 * Result shape for `patchSkillFile`. Agents read `status` to decide what
 * to surface back to the user.
 */
export interface PatchSkillResult {
    /** True iff the patch was applied. */
    ok: boolean;
    /**
     * - `replaced`         — patch applied successfully
     * - `not-found`        — `find` string doesn't occur in the file
     * - `wrong-count`      — `find` occurs N times but `expectedCount` ≠ N
     * - `skill-missing`    — no SKILL.md at the target path
     * - `unchanged`        — `find` === `replace` (no-op refused)
     */
    status: 'replaced' | 'not-found' | 'wrong-count' | 'skill-missing' | 'unchanged';
    /** Number of times `find` actually occurred. */
    matches: number;
    /** Human-readable summary for the agent to relay. */
    message: string;
}

/**
 * Find-and-replace within an existing SKILL.md. `patch` semantics:
 * exact-string match (no regex), atomic write, refuses unless `find`
 * occurs exactly `expectedCount` times (default 1). The strict-count check
 * prevents accidental over-replacement when a substring shows up in
 * unintended places.
 *
 * Use this when the agent needs to evolve a skill — fix a stale path,
 * correct a wrong example, refine wording — without rewriting the whole
 * SKILL.md. For full rewrites use `writeSkillFile` (after deleting).
 */
export async function patchSkillFile(
    skillsPath: string,
    skillName: string,
    find: string,
    replace: string,
    expectedCount = 1,
): Promise<PatchSkillResult> {
    const { file: destPath } = skillPaths(skillsPath, skillName);

    if (!existsSync(destPath)) {
        return {
            ok: false,
            status: 'skill-missing',
            matches: 0,
            message: `Skill "${skillName}" not found at ${destPath}`,
        };
    }
    if (find === replace) {
        return {
            ok: false,
            status: 'unchanged',
            matches: 0,
            message: `Refused: \`find\` and \`replace\` are identical — nothing to do.`,
        };
    }

    const existing = await readFile(destPath, 'utf-8');
    // Count occurrences via split — robust against escape pitfalls of indexOf-loop.
    const matches = existing.split(find).length - 1;

    if (matches === 0) {
        return {
            ok: false,
            status: 'not-found',
            matches: 0,
            message: `\`find\` string not present in "${skillName}". Read the file first to copy exact text including whitespace.`,
        };
    }
    if (matches !== expectedCount) {
        return {
            ok: false,
            status: 'wrong-count',
            matches,
            message: `\`find\` occurs ${matches}× but expectedCount=${expectedCount}. Make \`find\` more specific by including surrounding context, or set expectedCount=${matches} if you intend to replace all.`,
        };
    }

    const updated = existing.split(find).join(replace);
    const tmpPath = `${destPath}.tmp`;
    try {
        await writeFile(tmpPath, updated, 'utf-8');
        await rename(tmpPath, destPath);
        log.info({ skillName, matches }, 'skill patched');
        return {
            ok: true,
            status: 'replaced',
            matches,
            message: `Patched "${skillName}" — replaced ${matches} occurrence${matches === 1 ? '' : 's'}.`,
        };
    } catch (err) {
        try { await (await import('fs/promises')).unlink(tmpPath); } catch { /* ignored */ }
        throw err;
    }
}
