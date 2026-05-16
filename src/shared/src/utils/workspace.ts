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
 * Bootstrap-time: rewrite a RELATIVE `FLOPSY_HOME` in `process.env` to absolute,
 * anchored against `anchorDir` (usually the flopsy.json5 directory). Idempotent.
 */
export function primeFlopsyHome(anchorDir: string): string {
    const override = process.env.FLOPSY_HOME?.trim();
    if (override && !override.startsWith('~')) {
        const abs = resolve(anchorDir, override);
        if (abs !== override) process.env.FLOPSY_HOME = abs;
    }
    return resolveFlopsyHome();
}

/** Create the directory if absent; pure readers don't call this. */
export function ensureDir(dir: string): string {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
}

/**
 * Workspace path accessor bound to a specific environment. All accessors are
 * pure path resolution; writers call `ensureDir()` on the resolved path.
 *
 * Layout under <HOME>: config/, content/{skills,roles,prompts}, state/*.db,
 * cache/, auth/ (0700), logs/, work/{audio,video,code,images,docs,exports,scratch},
 * gateway.pid.
 */
export function createWorkspace(env: NodeJS.ProcessEnv = process.env) {
    const home = () => resolveFlopsyHome(env);
    const sub = (...parts: string[]) => join(home(), ...parts);

    return {
        /** Workspace root (e.g. ~/.flopsy) */
        root: home,

        // Config + content (human-edited).
        config:        (...parts: string[]) => sub('config', ...parts),
        content:       (...parts: string[]) => sub('content', ...parts),
        skills:        () => sub('content', 'skills'),
        /** Bundled-but-inactive skills; `flopsy skill install <name>` activates by copying into skills/. */
        skillsOptional: () => sub('content', 'skills-optional'),
        /** Agent-authored skills awaiting human review; `flopsy skill proposed accept` promotes into skills/. */
        skillsProposed: () => sub('content', 'skills-proposed'),
        roles:         () => sub('content', 'roles'),
        prompts:       (...parts: string[]) => sub('content', 'prompts', ...parts),
        hooks:         (...parts: string[]) => sub('content', 'hooks', ...parts),

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
        vaultDb:       () => sub('state', 'vault.db'),

        // Cache (safe to nuke).
        cache:         (...parts: string[]) => sub('cache', ...parts),
        toolOutputs:   () => sub('cache', 'tool-outputs'),
        workerOutputs: () => sub('cache', 'worker-outputs'),

        // The sandbox bind-mounts <HOME> as /workspace; paths under work/ map directly.
        work:          (...parts: string[]) => sub('work', ...parts),
        workAudio:     (...parts: string[]) => sub('work', 'audio', ...parts),
        workVideo:     (...parts: string[]) => sub('work', 'video', ...parts),
        workCode:      (...parts: string[]) => sub('work', 'code', ...parts),
        workImages:    (...parts: string[]) => sub('work', 'images', ...parts),
        workDocs:      (...parts: string[]) => sub('work', 'docs', ...parts),
        workExports:   (...parts: string[]) => sub('work', 'exports', ...parts),
        workScratch:   (...parts: string[]) => sub('work', 'scratch', ...parts),

        /** <os.tmpdir()>/flopsy-scratch — outside FLOPSY_HOME on purpose. */
        scratch:       () => join(tmpdir(), 'flopsy-scratch'),
    };
}

/** Subdirs under <HOME>/work the agent uses to organise outputs (iterable by bootstrap). */
export const WORK_SUBDIRS = [
    'audio',
    'video',
    'code',
    'images',
    'docs',
    'exports',
    'scratch',
] as const;

/** Default workspace bound to `process.env`. */
export const workspace = createWorkspace();

export type WorkspacePathResolver = ReturnType<typeof createWorkspace>;
