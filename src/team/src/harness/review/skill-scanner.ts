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
    // Supports both flat (skills/<skill>/SKILL.md) and grouped
    // (skills/<group>/<skill>/SKILL.md) layouts.
    for (const entry of entries) {
        const entryPath = join(skillsPath, entry);
        try {
            const s = statSync(entryPath);
            if (!s.isDirectory()) continue;
        } catch {
            continue;
        }
        const flatSkillMd = join(entryPath, 'SKILL.md');
        if (existsSync(flatSkillMd)) {
            tryPushSkill(out, flatSkillMd, entry);
            continue;
        }
        // Treat as group: scan one level deeper.
        let subEntries: string[];
        try {
            subEntries = readdirSync(entryPath);
        } catch {
            continue;
        }
        for (const sub of subEntries) {
            const subPath = join(entryPath, sub);
            try {
                const ss = statSync(subPath);
                if (!ss.isDirectory()) continue;
            } catch {
                continue;
            }
            const subSkillMd = join(subPath, 'SKILL.md');
            if (existsSync(subSkillMd)) tryPushSkill(out, subSkillMd, sub);
        }
    }
    return out;
}

function tryPushSkill(out: SkillCatalogEntry[], skillMdPath: string, dirName: string): void {
    let raw: string;
    try {
        raw = readFileSync(skillMdPath, 'utf-8');
    } catch {
        return;
    }
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return;
    const fmBody = fmMatch[1] ?? '';
    const nameMatch = fmBody.match(/^name:\s*(.+)$/m);
    const descMatch = fmBody.match(/^description:\s*(.+)$/m);
    const name = nameMatch?.[1]?.trim() ?? dirName;
    const description = descMatch?.[1]?.trim() ?? '';
    if (!description) return;
    out.push({ name, description });
}

export function slugifySkillName(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}
