import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@flopsy/shared';

const log = createLogger('skill-scanner');

export interface SkillCatalogEntry {
    name: string;
    description: string;
}

// Broken SKILL.md files are skipped silently rather than throwing.
export function scanExistingSkills(skillsPath: string): SkillCatalogEntry[] {
    if (!existsSync(skillsPath)) return [];
    let entries: string[];
    try {
        entries = readdirSync(skillsPath);
    } catch (err) {
        log.warn({ skillsPath, err: (err as Error).message }, 'skill scan failed');
        return [];
    }

    const out: SkillCatalogEntry[] = [];
    for (const entry of entries) {
        const entryPath = join(skillsPath, entry);
        try {
            const s = statSync(entryPath);
            if (!s.isDirectory()) continue;
        } catch {
            continue;
        }
        const skillMdPath = join(entryPath, 'SKILL.md');
        if (!existsSync(skillMdPath)) continue;

        let raw: string;
        try {
            raw = readFileSync(skillMdPath, 'utf-8');
        } catch {
            continue;
        }

        const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;
        const fmBody = fmMatch[1] ?? '';
        const nameMatch = fmBody.match(/^name:\s*(.+)$/m);
        const descMatch = fmBody.match(/^description:\s*(.+)$/m);
        const name = nameMatch?.[1]?.trim() ?? entry;
        const description = descMatch?.[1]?.trim() ?? '';
        if (!description) continue;

        out.push({ name, description });
    }
    return out;
}

export function slugifySkillName(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}
