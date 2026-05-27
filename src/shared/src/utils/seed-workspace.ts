/**
 * Workspace template seeder.
 *
 * Files: copy-if-missing. Folders: RECURSIVE MERGE — copy every template file
 * that's absent in the workspace, leaving existing files untouched. This means
 * a new prompt/skill/role dropped into `templates/` reaches BOTH fresh installs
 * AND existing workspaces on next boot (older "skip whole folder if present"
 * behavior silently starved existing workspaces of newly-added files).
 * `templatesDir` is passed in (typically `<repo>/src/team/templates`).
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { workspace, WORK_SUBDIRS } from './workspace';
import { createLogger } from './logger';

const log = createLogger('seed-workspace');

export interface SeedStats {
    seeded: number;
    skipped: number;
    failed: number;
}

// Destinations resolved via workspace accessor so layout changes propagate automatically.
export const TEMPLATE_FILES: ReadonlyArray<{ dest: () => string; templateName: string }> = [
    { dest: () => workspace.configFile(),                 templateName: 'flopsy.json5' },
    { dest: () => workspace.config('SOUL.md'),            templateName: 'SOUL.md' },
    { dest: () => workspace.config('AGENTS.md'),          templateName: 'AGENTS.md' },
    { dest: () => workspace.config('personalities.yaml'), templateName: 'personalities.yaml' },
    { dest: () => workspace.state('memory', 'USER.md'),   templateName: 'USER.md' },
    { dest: () => workspace.state('memory', 'MEMORY.md'), templateName: 'MEMORY.md' },
    // The two SILENT system heartbeats the engine auto-registers on every boot
    // (ensureSystemHeartbeats in proactive/engine.ts). They MUST exist on disk
    // or those fires degrade. Listed explicitly here as belt-and-suspenders in
    // addition to the prompts/ folder merge below — if anyone ever narrows the
    // folder list, these two named prompts still seed.
    { dest: () => workspace.prompts('heartbeats', 'self-improve.md'), templateName: 'prompts/heartbeats/self-improve.md' },
    { dest: () => workspace.prompts('heartbeats', 'dreaming.md'),     templateName: 'prompts/heartbeats/dreaming.md' },
];

// Folder-recursive MERGE. Every template file absent in the workspace is
// copied; existing files are left untouched. New files dropped into
// templates/{skills,roles,prompts}/ reach a fresh workspace AND back-fill
// existing workspaces on next boot — same shape as how skill/role authors
// already extend the catalog.
export const TEMPLATE_FOLDERS: ReadonlyArray<{ dest: () => string; templateName: string }> = [
    { dest: () => workspace.skills(),   templateName: 'skills' },
    { dest: () => workspace.roles(),    templateName: 'roles' },
    { dest: () => workspace.prompts(),  templateName: 'prompts' },
    { dest: () => workspace.hooks(),    templateName: 'hooks' },
];

/**
 * Recursively copy every file from `srcDir` into `destDir` that does NOT
 * already exist at the destination. Returns counts. Existing files are never
 * overwritten — the user owns their workspace edits. Empty dirs are created
 * so the tree shape matches even before files land.
 */
function mergeFolder(srcDir: string, destDir: string): { copied: number; skipped: number; failed: number } {
    let copied = 0;
    let skipped = 0;
    let failed = 0;
    let entries: string[];
    try {
        entries = readdirSync(srcDir);
    } catch (err) {
        log.warn({ srcDir, err: (err as Error).message }, 'seed: cannot read template folder; skipping');
        return { copied, skipped, failed: failed + 1 };
    }
    for (const entry of entries) {
        const srcPath = join(srcDir, entry);
        const destPath = join(destDir, entry);
        let st;
        try {
            st = statSync(srcPath);
        } catch {
            failed++;
            continue;
        }
        if (st.isDirectory()) {
            const sub = mergeFolder(srcPath, destPath);
            copied += sub.copied;
            skipped += sub.skipped;
            failed += sub.failed;
            continue;
        }
        if (existsSync(destPath)) {
            skipped++;
            continue;
        }
        try {
            mkdirSync(dirname(destPath), { recursive: true });
            copyFileSync(srcPath, destPath);
            copied++;
        } catch (err) {
            log.warn({ srcPath, destPath, err: (err as Error).message }, 'seed: merge copy failed; continuing');
            failed++;
        }
    }
    return { copied, skipped, failed };
}

function migrateLegacyMemoryFiles(): void {
    const legacy: Array<{ from: string; to: string }> = [
        { from: workspace.config('USER.md'),   to: workspace.state('memory', 'USER.md') },
        { from: workspace.config('MEMORY.md'), to: workspace.state('memory', 'MEMORY.md') },
    ];
    for (const { from, to } of legacy) {
        if (!existsSync(from)) continue;
        if (existsSync(to)) {
            try {
                unlinkSync(from);
                log.info({ from }, 'seed: removed orphan legacy memory file (dest exists)');
            } catch (err) {
                log.warn({ from, err: (err as Error).message }, 'seed: failed to remove orphan; continuing');
            }
            continue;
        }
        try {
            mkdirSync(dirname(to), { recursive: true });
            renameSync(from, to);
            log.info({ from, to }, 'seed: migrated legacy memory file to state/memory');
        } catch (err) {
            log.warn({ from, to, err: (err as Error).message }, 'seed: migration failed; continuing');
        }
    }
}

/** Copy missing templates from `templatesDir` into the workspace; existing entries untouched. */
export function seedWorkspaceTemplates(templatesDir: string): SeedStats {
    let seeded = 0;
    let skipped = 0;
    let failed = 0;

    migrateLegacyMemoryFiles();

    for (const t of TEMPLATE_FILES) {
        const dest = t.dest();
        if (existsSync(dest)) {
            skipped++;
            continue;
        }
        const src = join(templatesDir, t.templateName);
        if (!existsSync(src)) {
            log.warn(
                { templateName: t.templateName, src },
                'seed: template file missing in source tree; skipping',
            );
            failed++;
            continue;
        }
        try {
            mkdirSync(dirname(dest), { recursive: true });
            copyFileSync(src, dest);
            log.info({ src, dest }, 'seed: workspace template copied');
            seeded++;
        } catch (err) {
            log.warn(
                { src, dest, err: (err as Error).message },
                'seed: copy failed; continuing',
            );
            failed++;
        }
    }

    for (const t of TEMPLATE_FOLDERS) {
        const dest = t.dest();
        const src = join(templatesDir, t.templateName);
        if (!existsSync(src)) {
            log.warn(
                { templateName: t.templateName, src },
                'seed: template folder missing in source tree; skipping',
            );
            failed++;
            continue;
        }
        // Recursive merge — back-fills newly-added template files into existing
        // workspaces, not just fresh ones. Existing user files are preserved.
        mkdirSync(dest, { recursive: true });
        const result = mergeFolder(src, dest);
        seeded += result.copied;
        skipped += result.skipped;
        failed += result.failed;
        if (result.copied > 0) {
            log.info(
                { src, dest, copied: result.copied, skipped: result.skipped },
                'seed: workspace template folder merged',
            );
        }
    }

    // Empty dirs the agent/CLI write into lazily — pre-created so they're
    // present (and discoverable) from a fresh install: work/* + the
    // skills-proposed review queue.
    const emptyDirs = [...WORK_SUBDIRS.map((s) => workspace.work(s)), workspace.skillsProposed()];
    for (const dest of emptyDirs) {
        if (existsSync(dest)) {
            skipped++;
            continue;
        }
        try {
            mkdirSync(dest, { recursive: true });
            log.info({ dest }, 'seed: empty workspace dir created');
            seeded++;
        } catch (err) {
            log.warn(
                { dest, err: (err as Error).message },
                'seed: empty workspace dir create failed; continuing',
            );
            failed++;
        }
    }

    return { seeded, skipped, failed };
}
