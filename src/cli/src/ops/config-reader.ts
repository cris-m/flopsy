import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import JSON5 from 'json5';
import { primeFlopsyHome, resolveFlopsyHome, seedWorkspaceTemplates } from '@flopsy/shared';

export interface RawFlopsyConfig {
    agents?: ReadonlyArray<RawAgent>;
    mcp?: { enabled?: boolean; servers?: Record<string, RawMcpServer> };
    proactive?: RawProactive;
    webhook?: RawWebhook;
    channels?: Record<string, { enabled?: boolean }>;
    gateway?: { host?: string; port?: number };
    memory?: { enabled?: boolean; embedder?: { model?: string; baseUrl?: string; provider?: string } };
    logging?: { level?: string; file?: string };
    [k: string]: unknown;
}

export interface ModelRef {
    provider?: string;
    name?: string;
}

export interface RawAgent {
    name: string;
    type?: string;
    role?: string;
    enabled?: boolean;
    domain?: string;
    model?: string;
    model_config?: {
        temperature?: number;
        maxTokens?: number;
        [k: string]: unknown;
    };
    fallback_models?: readonly ModelRef[];
    cost_tier?: 'low' | 'medium' | 'high' | string;
    routing?: {
        enabled?: boolean;
        tiers?: {
            fast?: ModelRef;
            balanced?: ModelRef;
            powerful?: ModelRef;
        };
    };
    toolsets?: readonly string[];
    workers?: readonly string[];
    mcpServers?: readonly string[];
    approvals?: { tools?: readonly string[]; actions?: readonly string[] };
    /** Per-agent sandbox opt-in — matches `sandboxConfigSchema` in shared. */
    sandbox?: {
        enabled?: boolean;
        backend?: 'local' | 'docker' | 'kubernetes' | string;
        language?: 'python' | 'javascript' | 'typescript' | 'bash' | string;
        timeout?: number;
        memoryLimit?: number;
        cpuLimit?: number;
        networkEnabled?: boolean;
        keepAlive?: boolean;
        programmaticToolCalling?: boolean;
    };
}

export interface RawMcpServer {
    enabled?: boolean;
    transport?: string;
    command?: string;
    args?: readonly string[];
    url?: string;
    env?: Record<string, string>;
    requires?: readonly string[];
    requiresAuth?: readonly string[];
    platform?: string;
    assignTo?: readonly string[];
    description?: string;
}

export interface RawProactive {
    enabled?: boolean;
    /** Matches flopsy.json5 shape: `proactive.heartbeats.heartbeats[]`. */
    heartbeats?: { enabled?: boolean; heartbeats?: readonly RawHeartbeat[] };
    /** Matches flopsy.json5 shape: `proactive.scheduler.jobs[]`. */
    scheduler?: { enabled?: boolean; jobs?: readonly RawCronJob[] };
    webhooks?: readonly RawInboundWebhook[];
}

export interface RawHeartbeat {
    name?: string;
    enabled?: boolean;
    interval?: string;
    oneshot?: boolean;
    message?: string;
    deliveryMode?: string;
}

export interface RawCronJob {
    name?: string;
    enabled?: boolean;
    schedule?: string;
    message?: string;
    target?: unknown;
    deliveryMode?: string;
}

export interface RawInboundWebhook {
    name?: string;
    enabled?: boolean;
    path?: string;
    secret?: string;
}

export interface RawWebhook {
    enabled?: boolean;
    host?: string;
    port?: number;
    allowedIps?: readonly string[];
    secret?: string;
}

function findUp(start: string, candidates: readonly string[]): string | null {
    let dir = start;
    for (;;) {
        for (const name of candidates) {
            const candidate = resolve(dir, name);
            if (existsSync(candidate)) return candidate;
        }
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

let envLoadedFor: string | null = null;

/**
 * Load `.env` from the config's directory into `process.env` (once).
 * dotenv is non-overriding by default — values already set in the shell
 * win, so users can still `FLOPSY_CONFIG=... flopsy ...` to override.
 */
function ensureEnvLoaded(configDir: string): void {
    if (envLoadedFor === configDir) return;
    const envPath = resolve(configDir, '.env');
    if (existsSync(envPath)) {
        dotenv({ path: envPath });
        warnOnDuplicateEnvKeys(envPath);
    }
    envLoadedFor = configDir;
    primeFlopsyHome(configDir);
}

/**
 * Scan `.env` for duplicate key declarations and warn. dotenv's "last wins"
 * semantics silently shadow earlier lines — we hit a real incident where
 * `GOOGLE_CLIENT_ID` appeared twice with the client_secret matching only
 * the first, which broke OAuth refresh after the initial access token
 * expired. Catching it at load time is ~15 LOC of cheap insurance.
 */
function warnOnDuplicateEnvKeys(envPath: string): void {
    try {
        const raw = readFileSync(envPath, 'utf-8');
        const counts = new Map<string, number[]>();
        raw.split(/\r?\n/).forEach((line, idx) => {
            const trimmed = line.replace(/^\s*export\s+/, '').trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const eq = trimmed.indexOf('=');
            if (eq <= 0) return;
            const key = trimmed.slice(0, eq).trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
            const lines = counts.get(key) ?? [];
            lines.push(idx + 1);
            counts.set(key, lines);
        });
        for (const [key, lines] of counts) {
            if (lines.length > 1) {
                process.stderr.write(
                    `[flopsy] ⚠  .env has duplicate ${key} on lines ${lines.join(', ')} — ` +
                        `dotenv uses the LAST one. Remove the older entries.\n`,
                );
            }
        }
    } catch {
        // Best-effort — never fail bootstrap on a diagnostic check.
    }
}

/**
 * Run once at CLI startup — loads `.env` + primes FLOPSY_HOME for every
 * command, not just the ones that hit `readFlopsyConfig`. Without this
 * the `auth` / `env` / standalone commands read `process.env` before
 * dotenv ran, so user-set values in `.env` look unset.
 *
 * Silent on failure: if no `flopsy.json5` is reachable (e.g. `flopsy
 * --help` from `/tmp`), just skip — commands that need the config will
 * error later with their own clear message.
 */
export function bootstrapCli(): void {
    try {
        // Step 1 — find the repo by a marker that doesn't depend on env
        // vars (`src/team/templates/`), then load `.env` from there. This
        // populates FLOPSY_HOME in process.env BEFORE any FLOPSY_HOME-aware
        // path resolution runs. Without this, `configPath()` falls back to
        // `~/.flopsy/flopsy.json5` and the seeder writes templates into
        // your home directory instead of the project's `.flopsy/`.
        if (primeFromRepoRoot()) return;

        // Step 2 — fallback for environments where the CLI is not running
        // from inside a flopsybot repo (npm-linked install elsewhere etc.).
        // Use the legacy config-then-dirname path; `projectRootFromConfigPath`
        // strips a trailing `/.flopsy` so a workspace that already exists is
        // honoured.
        ensureEnvLoaded(projectRootFromConfigPath(configPath()));
    } catch {
        /* no config discoverable — commands that need it will tell the user */
    }
}

/**
 * Resolve the CLI's *install location* after following symlinks. When the
 * CLI is `npm link`-ed, `which flopsy` is a symlink into
 * `lib/node_modules/@flopsy/cli/src/index.ts`, which is itself a symlink
 * back to this repo's `src/cli`. `realpathSync` resolves both so we land
 * on the source-of-truth repo — the same repo the binary was linked
 * from. Mirrors how `app/src/main.ts` uses `createRequire(import.meta.url)`.
 */
function cliInstallDir(): string {
    try {
        return dirname(realpathSync(fileURLToPath(import.meta.url)));
    } catch {
        return dirname(fileURLToPath(import.meta.url));
    }
}

/**
 * Filenames searched at every level of the upward walk. Workspace-canonical
 * location is `.flopsy/config/flopsy.json5`; the bare `flopsy.json5`
 * fallback at the bottom catches developer-style setups (running the tool
 * from inside a repo dir that has its own config).
 */
const CONFIG_CANDIDATES = [
    '.flopsy/config/flopsy.json5',
    '.flopsy/config/flopsy.json',
    'flopsy.json5',
    'flopsy.json',
] as const;

/**
 * Given a discovered config path return the directory that owns the project
 * (the place `.env` lives, what `primeFlopsyHome` should anchor to, what
 * `npm start` should be spawned from). For workspace-canonical paths we
 * strip the trailing `/.flopsy/config` segment; for repo-local configs
 * we just take dirname.
 *
 * EXPORTED — multiple CLI commands need the repo root, not the config dir.
 */
export function projectRootFromConfigPath(configPath: string): string {
    let dir = dirname(configPath);
    // <root>/.flopsy/config/flopsy.json5 → strip /config then /.flopsy
    if (dir.endsWith(`${sep}config`) || dir === 'config' || dir.endsWith('/config')) {
        dir = dirname(dir);
    }
    if (dir.endsWith(`${sep}.flopsy`) || dir === '.flopsy' || dir.endsWith('/.flopsy')) {
        return dirname(dir);
    }
    return dir;
}

/**
 * Convenience: project root for the currently-discovered config. Use this
 * everywhere that previously did `dirname(configPath())`.
 */
export function projectRoot(): string {
    return projectRootFromConfigPath(configPath());
}

/**
 * Resolve the absolute config path. Priority:
 *   1. `FLOPSY_CONFIG` env var (explicit override)
 *   2. `FLOPSY_HOME/config/flopsy.json5` (when FLOPSY_HOME is set absolutely)
 *   3. Walk up from cwd — lets users target a specific repo by cd'ing in.
 *   4. Walk up from the CLI's install location — so `flopsy` works from
 *      any cwd, always finding the repo it was linked from
 *   5. Fallback: `<HOME>/config/flopsy.json5` (so error messages stay useful)
 */
export function configPath(): string {
    const env = process.env['FLOPSY_CONFIG'];
    if (env) return resolve(env);

    const homeAbs = resolveFlopsyHome();
    for (const name of ['flopsy.json5', 'flopsy.json']) {
        const candidate = resolve(homeAbs, 'config', name);
        if (existsSync(candidate)) return candidate;
    }

    const fromCwd = findUp(process.cwd(), CONFIG_CANDIDATES);
    if (fromCwd) return fromCwd;
    const fromInstall = findUp(cliInstallDir(), CONFIG_CANDIDATES);
    if (fromInstall) return fromInstall;
    return resolve(homeAbs, 'config', 'flopsy.json5');
}

/**
 * Walk up from `start` looking for the FlopsyBot repo root — the directory
 * that owns `src/team/templates/`. Used by:
 *   1. The self-healing seed step (workspace has no flopsy.json5 yet → we
 *      copy from this repo's bundled template).
 *   2. Early `.env` discovery: we MUST load `.env` before reading
 *      `FLOPSY_HOME`, but `configPath()` reads FLOPSY_HOME first, which is
 *      circular. Finding the repo by a template marker breaks the cycle —
 *      it doesn't need any env vars to be set.
 */
function findRepoRootWithTemplates(start: string): string | null {
    let dir = start;
    for (;;) {
        if (existsSync(resolve(dir, 'src', 'team', 'templates', 'flopsy.json5'))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * Discover the repo root and load its `.env` BEFORE any FLOPSY_HOME-aware
 * lookup runs. Idempotent — safe to call from both `bootstrapCli` and
 * `readFlopsyConfig`. Returns the repo root if found, null otherwise.
 *
 * Without this, `configPath()` runs with an unprimed `process.env`,
 * `resolveFlopsyHome()` defaults to `~/.flopsy`, and the self-heal seeder
 * writes the bundled templates into `~/.flopsy/` instead of the project's
 * `<repo>/.flopsy/`.
 */
function primeFromRepoRoot(): string | null {
    const repoRoot =
        findRepoRootWithTemplates(process.cwd()) ??
        findRepoRootWithTemplates(cliInstallDir());
    if (!repoRoot) return null;
    // ensureEnvLoaded both loads `.env` and calls `primeFlopsyHome`, so
    // after this returns process.env.FLOPSY_HOME is the absolute path
    // (relative `.flopsy` anchored against the repo root).
    ensureEnvLoaded(repoRoot);
    return repoRoot;
}

export function readFlopsyConfig(): { path: string; config: RawFlopsyConfig } {
    // Always prime from the repo root first — guarantees FLOPSY_HOME is
    // populated from `.env` before configPath() runs. Without this,
    // resolveFlopsyHome() defaults to `~/.flopsy` and we end up looking
    // for the config in the user's home dir even when their project's
    // `.env` says FLOPSY_HOME=.flopsy.
    const earlyRepoRoot = primeFromRepoRoot();

    let path = configPath();

    // Self-heal: a brand-new install (or a workspace someone just deleted)
    // has no flopsy.json5. Seed from the repo's bundled templates before
    // erroring. `npm start` does the same in main.ts; doing it here too
    // means `flopsy run start` works on a fresh checkout.
    if (!existsSync(path)) {
        const repoRoot =
            earlyRepoRoot ??
            findRepoRootWithTemplates(process.cwd()) ??
            findRepoRootWithTemplates(cliInstallDir());
        if (repoRoot) {
            const templatesDir = resolve(repoRoot, 'src', 'team', 'templates');
            // primeFromRepoRoot above already called primeFlopsyHome —
            // calling again is idempotent but ensures the right anchor
            // when this branch runs without an earlyRepoRoot.
            primeFlopsyHome(repoRoot);
            seedWorkspaceTemplates(templatesDir);
            // Re-resolve — the seed may have created `.flopsy/flopsy.json5`
            // for the first time, in which case the FLOPSY_HOME-first
            // lookup will find it now.
            path = configPath();
        }
    }

    if (!existsSync(path)) {
        throw new Error(
            `Cannot find flopsy.json5 (searched .flopsy/flopsy.json5 and flopsy.json5 from ${process.cwd()} upward). ` +
                `Set FLOPSY_HOME=/path/to/.flopsy or FLOPSY_CONFIG=/path/to/flopsy.json5, or cd into a FlopsyBot project.`,
        );
    }
    // Load `.env` from the PROJECT ROOT (not the config dir) — when the
    // config lives in `.flopsy/`, `.env` still belongs to the project root.
    // primeFlopsyHome runs against the project root too so a relative
    // `FLOPSY_HOME=.flopsy` anchors correctly.
    ensureEnvLoaded(projectRootFromConfigPath(path));
    const raw = readFileSync(path, 'utf-8');
    const config = JSON5.parse(raw) as RawFlopsyConfig;
    return { path, config };
}

// Flattened accessors — the config's real shape has nested wrappers
// (`proactive.heartbeats.heartbeats[]`) that leak into every command.
// These accessors hide the nesting so commands read naturally.

export function heartbeatsOf(config: RawFlopsyConfig): readonly RawHeartbeat[] {
    return config.proactive?.heartbeats?.heartbeats ?? [];
}

export function cronJobsOf(config: RawFlopsyConfig): readonly RawCronJob[] {
    return config.proactive?.scheduler?.jobs ?? [];
}

export function inboundWebhooksOf(config: RawFlopsyConfig): readonly RawInboundWebhook[] {
    return config.proactive?.webhooks ?? [];
}
