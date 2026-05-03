/**
 * Workspace template seeder — team-package wrapper.
 *
 * The seeding logic now lives in `@flopsy/shared` so the CLI can call it
 * without pulling in this package's heavy deps. This wrapper exists for
 * back-compat (`bootstrap.ts` and existing call sites already import
 * `seedWorkspaceTemplates` from `@flopsy/team`) and to compute the
 * templates directory from this file's `import.meta.url`.
 *
 * The starter files themselves still live under
 * `src/team/templates/` — closest to the team logic that consumes them
 * (SOUL.md, AGENTS.md, personalities.yaml, flopsy.json5, skills/).
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    seedWorkspaceTemplates as seedFromTemplatesDir,
    type SeedStats,
} from '@flopsy/shared';

function templatesDir(): string {
    const here = fileURLToPath(new URL('.', import.meta.url));
    return join(here, '..', 'templates');
}

export function seedWorkspaceTemplates(): SeedStats {
    return seedFromTemplatesDir(templatesDir());
}

/**
 * Returns the absolute path to the team package's `templates/` directory.
 * Exposed so other packages (CLI) can pass it to
 * `@flopsy/shared.seedWorkspaceTemplates` without re-deriving it from
 * `import.meta.url` themselves.
 */
export function teamTemplatesDir(): string {
    return templatesDir();
}
