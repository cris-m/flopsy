import { copyFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveWorkspacePath } from './workspace';

export type PromptKind = 'heartbeat' | 'cron';

export const PROMPT_KIND_DIR: Record<PromptKind, string> = {
    heartbeat: 'heartbeats',
    cron: 'cron',
};

/**
 * Directory under the workspace where prompts for a given kind live.
 * Always inside FLOPSY_HOME — no cwd fallback.
 */
export function promptDir(kind: PromptKind): string {
    return resolveWorkspacePath('proactive', PROMPT_KIND_DIR[kind]);
}

/**
 * Absolute path to a stored prompt filename. Absolute inputs are passed
 * through (escape hatch); relative filenames are resolved to the workspace.
 */
export function resolvePromptPath(filename: string, kind: PromptKind): string {
    if (filename.startsWith('/')) return filename;
    return join(promptDir(kind), filename);
}

/**
 * Copy a user-supplied prompt file into the workspace so the schedule owns
 * its copy. The stored filename is `<scheduleId>-<basename>` — each schedule
 * has a unique file, so delete-on-remove is unambiguous.
 *
 * Returns the filename (NOT the absolute path) to store in config_json.
 */
export async function copyPromptFile(
    srcPath: string,
    scheduleId: string,
    kind: PromptKind,
): Promise<string> {
    const filename = `${scheduleId}-${basename(srcPath)}`;
    const destDir = promptDir(kind);
    await mkdir(destDir, { recursive: true });
    await copyFile(srcPath, join(destDir, filename));
    return filename;
}

/**
 * Delete the workspace copy of a prompt file. Idempotent — silently
 * succeeds if the file is already gone, so it's safe to call on every
 * schedule delete without checking ownership first.
 */
export async function deletePromptFile(filename: string, kind: PromptKind): Promise<void> {
    if (filename.startsWith('/')) return; // absolute = user's own file, don't touch
    const filePath = join(promptDir(kind), filename);
    if (existsSync(filePath)) {
        await unlink(filePath);
    }
}

/**
 * Read a prompt file from the workspace, namespaced by kind. Absolute
 * paths are passed through. Used by the proactive engine at fire-time.
 */
export async function readPromptFile(filename: string, kind: PromptKind): Promise<string> {
    return readFile(resolvePromptPath(filename, kind), 'utf8');
}
