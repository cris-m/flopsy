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

/**
 * Append bullet points to the `## Lessons Learned` section of an existing skill.
 * Creates the section at the end of the file if it doesn't exist yet.
 * Returns false if the skill directory/file doesn't exist.
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
        const newLines = lessons.map((l) => `- ${l}`).join('\n');
        updated = `${existing.trimEnd()}\n\n${LESSONS_HEADER}\n${newLines}\n`;
    } else {
        const afterHeader = existing.indexOf('\n## ', headerIdx + 1);
        const insertAt = afterHeader === -1 ? existing.length : afterHeader;
        const newLines = '\n' + lessons.map((l) => `- ${l}`).join('\n');
        updated = existing.slice(0, insertAt) + newLines + existing.slice(insertAt);
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
