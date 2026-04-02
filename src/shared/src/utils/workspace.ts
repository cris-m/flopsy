import { homedir, tmpdir } from 'os';
import { resolve, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

/**
 * Resolve the Flopsy workspace root directory.
 *
 * Priority:
 * 1. `FLOPSY_HOME` env var (explicit override)
 * 2. `FLOPSY_PROFILE` env var → `~/.flopsy-{profile}`
 * 3. Default → `~/.flopsy`
 */
export function resolveFlopsyHome(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.FLOPSY_HOME?.trim();
    if (override) {
        if (override.startsWith('~')) {
            return resolve(override.replace(/^~(?=$|[\\/])/, homedir()));
        }
        return resolve(override);
    }

    const profile = env.FLOPSY_PROFILE?.trim();
    if (profile && profile !== 'default') {
        if (!/^[a-zA-Z0-9_-]+$/.test(profile)) {
            throw new Error(
                `Invalid FLOPSY_PROFILE: must contain only letters, digits, hyphens, or underscores`,
            );
        }
        return join(homedir(), `.flopsy-${profile}`);
    }

    return join(homedir(), '.flopsy');
}

/**
 * Join path segments onto the workspace root.
 */
export function resolveWorkspacePath(...parts: string[]): string {
    return join(resolveFlopsyHome(), ...parts);
}

/**
 * Ensure a directory exists. Called by components that need to write.
 * Pure readers never call this — they just resolve paths.
 */
export function ensureDir(dir: string): string {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
}

/**
 * Create a workspace path accessor bound to a specific environment.
 *
 * All accessors are pure path resolution — no filesystem side effects.
 * Components that write call `ensureDir()` on the path they need.
 *
 * @param env - Environment variables to resolve paths from. Defaults to
 *              `process.env`, but tests can pass a plain object to avoid
 *              mutating the real process environment.
 */
export function createWorkspace(env: NodeJS.ProcessEnv = process.env) {
    const home = () => resolveFlopsyHome(env);
    const sub = (...parts: string[]) => join(home(), ...parts);

    return {
        /** Workspace root (e.g. ~/.flopsy) */
        root: home,
        state: (...parts: string[]) => sub('state', ...parts),
        sessions: (...parts: string[]) => sub('sessions', ...parts),
        prompts: () => sub('prompts'),
        credentials: (...parts: string[]) => sub('credentials', ...parts),
        logs: () => sub('logs'),
        memory: () => sub('memory'),
        checkpoints: () => sub('checkpoints'),
        cache: (...parts: string[]) => sub('cache', ...parts),
        agents: () => sub('agents'),
        skills: () => sub('skills'),
        learning: () => sub('learning'),
        data: (...parts: string[]) => sub('data', ...parts),
        dataAgent: () => sub('data', 'agent'),
        dataCheckpoints: () => sub('data', 'checkpoints'),
        config: () => sub('config.json5'),
        storeDb: () => sub('store.db'),
        checkpointsDb: () => sub('checkpoints.db'),
        pidFile: () => sub('gateway.pid'),
        /** <os.tmpdir()>/flopsy-scratch */
        scratch: () => join(tmpdir(), 'flopsy-scratch'),
    };
}

/** Default workspace bound to `process.env`. */
export const workspace = createWorkspace();

export type WorkspacePathResolver = ReturnType<typeof createWorkspace>;
