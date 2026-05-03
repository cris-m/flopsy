/**
 * Workspace template seeder (shared).
 *
 * Lives in `@flopsy/shared` so both the app entrypoint (`src/app/main.ts`)
 * and the CLI (`flopsy run start`) can call it without pulling in
 * `@flopsy/team`'s heavy deps. The team package re-exports
 * `seedWorkspaceTemplates` so existing call sites keep working.
 *
 * The actual template files (SOUL.md, AGENTS.md, personalities.yaml,
 * flopsy.json5, skills/) still live under `src/team/templates/`. We pass
 * the templates directory in as an argument rather than computing it from
 * `import.meta.url` — that way nothing about the seeder's location matters.
 *
 * Behaviour:
 *   - Files (TEMPLATE_FILES): copy if missing in the workspace; never
 *     overwrite an existing file.
 *   - Folders (TEMPLATE_FOLDERS): copy the whole tree if the destination
 *     folder is absent. Once the folder exists (even empty) we leave it
 *     alone so users can prune subdirectories without us re-seeding them.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { resolveWorkspacePath } from './workspace';
import { createLogger } from './logger';

const log = createLogger('seed-workspace');

export interface SeedStats {
    seeded: number;
    skipped: number;
    failed: number;
}

// v2 layout: config files live under config/, content folders under content/.
// See workspace.ts for the full layout documentation.
export const TEMPLATE_FILES: ReadonlyArray<{ workspaceName: string; templateName: string }> = [
    { workspaceName: 'config/flopsy.json5',       templateName: 'flopsy.json5' },
    { workspaceName: 'config/SOUL.md',            templateName: 'SOUL.md' },
    { workspaceName: 'config/AGENTS.md',          templateName: 'AGENTS.md' },
    { workspaceName: 'config/personalities.yaml', templateName: 'personalities.yaml' },
];

export const TEMPLATE_FOLDERS: ReadonlyArray<{ workspaceName: string; templateName: string }> = [
    { workspaceName: 'content/skills', templateName: 'skills' },
    { workspaceName: 'content/roles',  templateName: 'roles' },
];

/**
 * Copy any missing template files + folders from `templatesDir` into the
 * workspace. Existing entries are left untouched.
 *
 * `templatesDir` is the absolute path to the directory that holds the
 * starter files — typically `<repo>/src/team/templates/`. The caller
 * resolves it; we don't go hunting for it.
 */
export function seedWorkspaceTemplates(templatesDir: string): SeedStats {
    let seeded = 0;
    let skipped = 0;
    let failed = 0;

    for (const t of TEMPLATE_FILES) {
        const dest = resolveWorkspacePath(t.workspaceName);
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
        const dest = resolveWorkspacePath(t.workspaceName);
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

    return { seeded, skipped, failed };
}
