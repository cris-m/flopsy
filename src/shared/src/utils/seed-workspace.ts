/**
 * Workspace template seeder.
 *
 * Files: copy-if-missing. Folders: copy whole tree if absent (existing folder is left as-is).
 * `templatesDir` is passed in (typically `<repo>/src/team/templates`).
 */

import { copyFileSync, cpSync, existsSync, mkdirSync } from 'fs';
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
    { dest: () => workspace.config('USER.md'),            templateName: 'USER.md' },
    { dest: () => workspace.config('AGENTS.md'),          templateName: 'AGENTS.md' },
    { dest: () => workspace.config('personalities.yaml'), templateName: 'personalities.yaml' },
];

export const TEMPLATE_FOLDERS: ReadonlyArray<{ dest: () => string; templateName: string }> = [
    { dest: () => workspace.skills(), templateName: 'skills' },
    { dest: () => workspace.roles(),  templateName: 'roles' },
];

/** Copy missing templates from `templatesDir` into the workspace; existing entries untouched. */
export function seedWorkspaceTemplates(templatesDir: string): SeedStats {
    let seeded = 0;
    let skipped = 0;
    let failed = 0;

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
        if (existsSync(dest)) {
            skipped++;
            continue;
        }
        const src = join(templatesDir, t.templateName);
        if (!existsSync(src)) {
            log.warn(
                { templateName: t.templateName, src },
                'seed: template folder missing in source tree; skipping',
            );
            failed++;
            continue;
        }
        try {
            mkdirSync(dirname(dest), { recursive: true });
            cpSync(src, dest, { recursive: true });
            log.info({ src, dest }, 'seed: workspace template folder copied');
            seeded++;
        } catch (err) {
            log.warn(
                { src, dest, err: (err as Error).message },
                'seed: folder copy failed; continuing',
            );
            failed++;
        }
    }

    // Create empty <HOME>/work/* subdirs for the agent's writes.
    for (const subdir of WORK_SUBDIRS) {
        const dest = workspace.work(subdir);
        if (existsSync(dest)) {
            skipped++;
            continue;
        }
        try {
            mkdirSync(dest, { recursive: true });
            log.info({ dest }, 'seed: work subdir created');
            seeded++;
        } catch (err) {
            log.warn(
                { dest, err: (err as Error).message },
                'seed: work subdir create failed; continuing',
            );
            failed++;
        }
    }

    return { seeded, skipped, failed };
}
