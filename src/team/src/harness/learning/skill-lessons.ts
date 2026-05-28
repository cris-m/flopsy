import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

export interface SkillLesson {
    readonly skill: string;
    readonly lesson: string;
}

const LESSON_MAX_CHARS = 160;

function extractLessons(content: string): string[] {
    const lines = content.split('\n');
    const start = lines.findIndex((l) => /^#{1,6}\s+lessons\s+learned\b/i.test(l.trim()));
    if (start === -1) return [];
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^#{1,6}\s/.test(line.trim())) break;
        const m = line.match(/^\s*[-*]\s+(.*\S)/);
        if (m?.[1]) out.push(m[1].trim().slice(0, LESSON_MAX_CHARS));
    }
    return out;
}

function readSkill(path: string): { mtimeMs: number; lessons: string[] } | null {
    try {
        const content = readFileSync(path, 'utf-8');
        const lessons = extractLessons(content);
        if (lessons.length === 0) return null;
        return { mtimeMs: statSync(path).mtimeMs, lessons };
    } catch {
        return null;
    }
}

export function collectSkillLessons(skillsRoot: string, opts: { limit: number }): SkillLesson[] {
    let groups: string[];
    try {
        groups = readdirSync(skillsRoot);
    } catch {
        return [];
    }

    const perSkill: Array<{ skill: string; mtimeMs: number; lessons: string[] }> = [];
    const consider = (skillName: string, mdPath: string): void => {
        const r = readSkill(mdPath);
        if (r) perSkill.push({ skill: skillName, mtimeMs: r.mtimeMs, lessons: r.lessons });
    };

    for (const entry of groups) {
        const entryPath = join(skillsRoot, entry);
        let isDir = false;
        try { isDir = statSync(entryPath).isDirectory(); } catch { continue; }
        if (!isDir) continue;

        const flat = join(entryPath, 'SKILL.md');
        try { if (statSync(flat).isFile()) { consider(entry, flat); continue; } } catch { /* grouped */ }

        let subs: string[];
        try { subs = readdirSync(entryPath); } catch { continue; }
        for (const sub of subs) {
            const sm = join(entryPath, sub, 'SKILL.md');
            try { if (statSync(sm).isFile()) consider(sub, sm); } catch { /* skip */ }
        }
    }

    perSkill.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: SkillLesson[] = [];
    for (const s of perSkill) {
        for (const lesson of s.lessons) {
            if (out.length >= opts.limit) return out;
            out.push({ skill: s.skill, lesson });
        }
    }
    return out;
}
