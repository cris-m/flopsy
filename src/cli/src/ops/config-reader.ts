/**
 * Shared config-file reader for the ops commands. All of `status`,
 * `team`, `cron`, `heartbeat`, `webhook` need to peek at the same
 * `flopsy.json5` — this module caches + validates the read so each
 * subcommand stays tiny.
 *
 * Honours FLOPSY_CONFIG override to match `mcp/commands.ts`.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import JSON5 from 'json5';
import { primeFlopsyHome } from '@flopsy/shared';

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

/**
 * Walk up from `start` looking for one of the candidate filenames.
 * Mirrors how git finds the repo root — lets users run `flopsy` from any
 * subdirectory of their project.
 */
function findUp(start: string, candidates: readonly string[]): string | null {
    let dir = start;
    // `dirname('/')` returns '/' on POSIX and 'C:\\' on Windows — both stop here.
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
        ensureEnvLoaded(dirname(configPath()));
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
 * Resolve the absolute config path. Priority:
 *   1. `FLOPSY_CONFIG` env var (explicit override)
 *   2. Walk up from cwd — lets users target a specific repo by cd'ing in
 *   3. Walk up from the CLI's install location — so `flopsy` works from
 *      any cwd, always finding the repo it was linked from
 *   4. Fallback: `<cwd>/flopsy.json5` (so error messages stay useful)
 */
export function configPath(): string {
    const env = process.env['FLOPSY_CONFIG'];
    if (env) return resolve(env);
    const fromCwd = findUp(process.cwd(), ['flopsy.json5', 'flopsy.json']);
    if (fromCwd) return fromCwd;
    const fromInstall = findUp(cliInstallDir(), ['flopsy.json5', 'flopsy.json']);
    if (fromInstall) return fromInstall;
    return resolve(process.cwd(), 'flopsy.json5');
}

export function readFlopsyConfig(): { path: string; config: RawFlopsyConfig } {
    const path = configPath();
    if (!existsSync(path)) {
        throw new Error(
            `Cannot find flopsy.json5 (searched from ${process.cwd()} upward). ` +
                `Set FLOPSY_CONFIG=/path/to/flopsy.json5 or cd into a FlopsyBot project.`,
        );
    }
    // Load sibling .env so $VAR expansion + FLOPSY_HOME etc. work the
    // same as `npm start` does. Must happen before we parse the JSON5
    // in case the file references env vars.
    ensureEnvLoaded(dirname(path));
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
