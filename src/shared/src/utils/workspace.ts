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
 *
 * `anchorDir` controls how a RELATIVE FLOPSY_HOME is interpreted:
 *   - absent → `resolve(override)` uses process.cwd() (legacy behaviour).
 *   - present → relative paths anchor to `anchorDir` (usually the dir
 *     containing flopsy.json5). Gateway's main.ts and CLI's config-reader
 *     both pass the config dir so running from any subdirectory yields
 *     the same workspace.
 */
export function resolveFlopsyHome(
    env: NodeJS.ProcessEnv = process.env,
    anchorDir?: string,
): string {
    const override = env.FLOPSY_HOME?.trim();
    if (override) {
        if (override.startsWith('~')) {
            return resolve(override.replace(/^~(?=$|[\\/])/, homedir()));
        }
        return anchorDir ? resolve(anchorDir, override) : resolve(override);
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

export function resolveWorkspacePath(...parts: string[]): string {
    return join(resolveFlopsyHome(), ...parts);
}

/**
 * Bootstrap-time helper: if `FLOPSY_HOME` is set and RELATIVE (neither
 * absolute nor tilde-prefixed), rewrite it in `process.env` so every
 * downstream `resolveFlopsyHome()` / `workspace.*` call sees an
 * absolute path. Callers pass the dir that relative paths should
 * anchor to — usually the directory containing `flopsy.json5`.
 *
 * Returns the resolved absolute home (whatever `resolveFlopsyHome`
 * would now return). Safe to call more than once; idempotent.
 */
export function primeFlopsyHome(anchorDir: string): string {
    const override = process.env.FLOPSY_HOME?.trim();
    if (override && !override.startsWith('~')) {
        const abs = resolve(anchorDir, override);
        if (abs !== override) process.env.FLOPSY_HOME = abs;
    }
    return resolveFlopsyHome();
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

    /**
     * Workspace layout:
     *
     *   <HOME>/
     *     config/         — human-edited config (flopsy.json5, SOUL.md, AGENTS.md, personalities.yaml)
     *     content/        — human-authored prompts/skills (skills/, roles/, prompts/)
     *     state/          — machine-managed databases (proactive.db, memory.db,
     *                        checkpoints.db, learning.db, *.json snapshots)
     *     cache/          — regenerable artifacts (tool-outputs/, worker-outputs/)
     *     auth/           — credentials (mode 0o700)
     *     logs/           — rotating log files
     *     gateway.pid     — daemon PID
     */
    return {
        /** Workspace root (e.g. ~/.flopsy) */
        root: home,

        // Config + content (human-edited).
        config:        (...parts: string[]) => sub('config', ...parts),
        content:       (...parts: string[]) => sub('content', ...parts),
        skills:        () => sub('content', 'skills'),
        roles:         () => sub('content', 'roles'),
        prompts:       (...parts: string[]) => sub('content', 'prompts', ...parts),

        // Authoritative config file path — `loadConfig()` reads from here.
        configFile:    () => sub('config', 'flopsy.json5'),

        // Auth + transient runtime.
        auth:          (...parts: string[]) => sub('auth', ...parts),
        logs:          () => sub('logs'),
        pidFile:       () => sub('gateway.pid'),

        // Machine state — DB files live directly under state/.
        state:         (...parts: string[]) => sub('state', ...parts),
        memoryDb:      () => sub('state', 'memory.db'),
        checkpointsDb: () => sub('state', 'checkpoints.db'),
        learningDb:    () => sub('state', 'learning.db'),

        // Cache (safe to nuke).
        cache:         (...parts: string[]) => sub('cache', ...parts),
        toolOutputs:   () => sub('cache', 'tool-outputs'),
        workerOutputs: () => sub('cache', 'worker-outputs'),

        /** <os.tmpdir()>/flopsy-scratch — outside FLOPSY_HOME on purpose. */
        scratch:       () => join(tmpdir(), 'flopsy-scratch'),
    };
}

/** Default workspace bound to `process.env`. */
export const workspace = createWorkspace();

export type WorkspacePathResolver = ReturnType<typeof createWorkspace>;
