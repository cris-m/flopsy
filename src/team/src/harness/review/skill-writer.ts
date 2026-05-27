import { writeFile, rename, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import { createLogger } from '@flopsy/shared';
import { scanSkillContent, hasCriticalFinding } from './skill-content-scanner';
import { SkillUsageStore, lessonFingerprint } from './skill-usage-store';

const log = createLogger('skill-writer');

// Grouped layout when category given, else flat (legacy): <skillsPath>/[category/]<skillName>/SKILL.md
function skillPaths(skillsPath: string, skillName: string, category?: string) {
    const dir = category
        ? join(skillsPath, category, skillName)
        : join(skillsPath, skillName);
    const file = join(dir, 'SKILL.md');
    return { dir, file };
}

// Category becomes a path segment, so it must be a single safe identifier.
// Open-ended (any new group is allowed) but no dots/slashes/traversal.
const SAFE_CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function extractCategory(content: string): string | null {
    if (!content.startsWith('---')) return null;
    const closeIdx = content.indexOf('\n---', 3);
    if (closeIdx === -1) return null;
    const fm = content.slice(3, closeIdx);
    const m = fm.match(/^category:\s*(.+)$/m);
    if (!m?.[1]) return null;
    const category = m[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
    return SAFE_CATEGORY_RE.test(category) ? category : null;
}

function skillExistsAnywhere(skillsPath: string, skillName: string): boolean {
    return resolveExistingSkillFile(skillsPath, skillName) !== null;
}

function resolveExistingSkillFile(skillsPath: string, skillName: string): string | null {
    const flat = join(skillsPath, skillName, 'SKILL.md');
    if (existsSync(flat)) return flat;
    let groups: string[];
    try { groups = readdirSync(skillsPath); }
    catch { return null; }
    for (const group of groups) {
        const groupPath = join(skillsPath, group);
        try { if (!statSync(groupPath).isDirectory()) continue; }
        catch { continue; }
        const candidate = join(groupPath, skillName, 'SKILL.md');
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

// The skills() interceptor ignores a skill unless frontmatter `name:` matches its directory.
function ensureNameField(content: string, skillName: string): string {
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

// Skips if the name exists anywhere (never overwrite human-edited skills); tmp+rename so the
// interceptor never reads a partial file mid-scan.
export async function writeSkillFile(
    skillsPath: string,
    skillName: string,
    content: string,
): Promise<boolean> {
    if (skillExistsAnywhere(skillsPath, skillName)) {
        log.debug({ skillName }, 'skill already exists somewhere under skillsPath — skipping write');
        return false;
    }

    const oversize = checkSkillSize(content);
    if (oversize) {
        log.warn({ skillName, reason: oversize }, 'skill write BLOCKED — size cap exceeded');
        return false;
    }

    const scanFindings = scanSkillContent(content);
    if (hasCriticalFinding(scanFindings)) {
        log.warn(
            { skillName, findings: scanFindings.map((f) => ({ rule: f.rule, severity: f.severity })) },
            'skill write BLOCKED — content contains critical danger patterns',
        );
        return false;
    }
    if (scanFindings.length > 0) {
        log.info(
            { skillName, findings: scanFindings.map((f) => f.rule) },
            'skill write proceeding with non-critical scan findings',
        );
    }

    const category = extractCategory(content);
    const { dir, file: destPath } = skillPaths(skillsPath, skillName, category ?? undefined);

    await mkdir(dir, { recursive: true });

    const normalizedContent = ensureNameField(content, skillName);
    const tmpPath = `${destPath}.tmp`;
    try {
        await writeFile(tmpPath, normalizedContent, 'utf-8');
        await rename(tmpPath, destPath);
        log.info({ skillName, category, path: destPath }, 'skill written');
        return true;
    } catch (err) {
        try { await (await import('fs/promises')).unlink(tmpPath); } catch { /* ignored */ }
        throw err;
    }
}

// Newest-wins cap so the self-improve heartbeat can't grow the section unboundedly.
const MAX_LESSONS_PER_SKILL = 20;

// agentskills.io progressive-disclosure guidance; bigger skills move detail to reference/ subfiles.
const MAX_SKILL_LINES = 500;
function checkSkillSize(content: string): string | null {
    const lines = content.split('\n').length;
    if (lines > MAX_SKILL_LINES) {
        return (
            `SKILL.md is ${lines} lines, over the ${MAX_SKILL_LINES}-line cap. ` +
            `Move detailed sections into reference/ subfiles and link to them ` +
            `(see skill-creator for the progressive-disclosure pattern).`
        );
    }
    return null;
}

export async function appendLessonsToSkill(
    skillsPath: string,
    skillName: string,
    lessons: string[],
): Promise<boolean> {
    if (lessons.length === 0) return false;
    // Rejected-edit buffer: never re-apply a lesson the validation gate reverted for hurting engagement.
    const rejected = new Set(new SkillUsageStore(skillsPath).getRejectedEdits(skillName));
    if (rejected.size > 0) {
        lessons = lessons.filter((l) => !rejected.has(lessonFingerprint(l)));
        if (lessons.length === 0) return false;
    }
    const destPath = resolveExistingSkillFile(skillsPath, skillName);
    if (!destPath) {
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
        const sectionStart = headerIdx + LESSONS_HEADER.length;
        const afterHeader = existing.indexOf('\n## ', headerIdx + 1);
        const sectionEnd = afterHeader === -1 ? existing.length : afterHeader;
        const sectionBody = existing.slice(sectionStart, sectionEnd);

        const existingBullets = sectionBody
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('- '))
            .map((line) => line.slice(2));

        // Reverse-dedup keeps the latest occurrence, so a re-stated lesson refreshes its position
        // instead of stacking verbatim copies every fire.
        const combined = [...existingBullets, ...lessons];
        const seen = new Set<string>();
        const deduped: string[] = [];
        for (let i = combined.length - 1; i >= 0; i--) {
            const key = combined[i]!.trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            deduped.unshift(combined[i]!);
        }
        const capped = deduped.slice(-MAX_LESSONS_PER_SKILL);
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

export async function bumpSkillVersion(
    skillsPath: string,
    skillName: string,
    version: string,
): Promise<boolean> {
    const destPath = resolveExistingSkillFile(skillsPath, skillName);
    if (!destPath) {
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

export interface PatchSkillResult {
    ok: boolean;
    status: 'replaced' | 'not-found' | 'wrong-count' | 'skill-missing' | 'unchanged';
    matches: number;
    message: string;
}

// Exact-string (no regex), atomic; refuses unless `find` occurs exactly expectedCount times,
// guarding against accidental over-replacement.
export async function patchSkillFile(
    skillsPath: string,
    skillName: string,
    find: string,
    replace: string,
    expectedCount = 1,
): Promise<PatchSkillResult> {
    const destPath = resolveExistingSkillFile(skillsPath, skillName);
    if (!destPath) {
        return {
            ok: false,
            status: 'skill-missing',
            matches: 0,
            message: `Skill "${skillName}" not found under ${skillsPath} (checked flat + grouped layouts)`,
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
    const oversize = checkSkillSize(updated);
    if (oversize) {
        return {
            ok: false,
            status: 'unchanged',
            matches,
            message: `Refused: post-patch ${oversize}`,
        };
    }
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
