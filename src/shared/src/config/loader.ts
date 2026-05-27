import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve, isAbsolute } from 'path';
import JSON5 from 'json5';
import { ZodError } from 'zod';
import { flopsyConfigSchema, type FlopsyConfig } from './schema';
import { resolveFlopsyHome } from '../utils/workspace';

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const PATH_KEY_RE = /(path|dir|file)$/i;

// Keys re-resolved downstream with subdir awareness (resolveWorkspaceConfigPath
// with a `state` default). The loader must NOT pre-anchor them to the HOME root,
// or a bare "proactive.json" becomes <HOME>/proactive.json and the later
// state/-resolution sees an absolute path and no-ops — splitting state out of state/.
const SUBDIR_RESOLVED_KEYS = new Set(['statePath', 'retryQueuePath', 'dedupDbPath']);

const DEFAULT_CONFIG_PATHS = ['flopsy.json5', 'flopsy.json'];

let cached: FlopsyConfig | null = null;

function resolveEnvVars(text: string): string {
    return text.replace(ENV_VAR_PATTERN, (match, name: string) => {
        const value = process.env[name];
        if (value === undefined) return match;
        return value;
    });
}

/**
 * Determine the workspace root directory from config.
 * Falls back to `resolveFlopsyHome()` when no explicit root is set.
 */
function resolveWorkspaceRoot(config: Record<string, unknown>): string {
    const ws = config.workspace as { root?: string } | undefined;
    if (ws?.root && typeof ws.root === 'string') {
        return resolve(ws.root.replace(/^~(?=$|[\\/])/, homedir()));
    }
    return resolveFlopsyHome();
}

function resolveWorkspacePaths(obj: unknown, root: string): void {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof value === 'string' && PATH_KEY_RE.test(key) && !SUBDIR_RESOLVED_KEYS.has(key)) {
            if (!value.startsWith('${') && !isAbsolute(value) && value.length > 0) {
                (obj as Record<string, unknown>)[key] = resolve(root, value);
            }
        } else if (typeof value === 'object' && value !== null) {
            resolveWorkspacePaths(value, root);
        }
    }
}

function findConfigFile(explicitPath?: string): string | null {
    if (explicitPath) {
        const resolved = resolve(explicitPath);
        if (existsSync(resolved)) return resolved;
        return null;
    }

    const envPath = process.env.FLOPSY_CONFIG;
    if (envPath) {
        const resolved = resolve(envPath);
        if (existsSync(resolved)) return resolved;
    }

    // Workspace-first: the canonical config lives at .flopsy/config/flopsy.json5
    // (seeded from src/team/templates/flopsy.json5 on first boot). The cwd
    // fallback below catches running the tool from inside a repo dir with a
    // local flopsy.json5 (developer convenience).
    const wsPath = resolveFlopsyHome();
    for (const name of DEFAULT_CONFIG_PATHS) {
        const resolved = resolve(wsPath, 'config', name);
        if (existsSync(resolved)) return resolved;
    }

    for (const candidate of DEFAULT_CONFIG_PATHS) {
        const resolved = resolve(candidate);
        if (existsSync(resolved)) return resolved;
    }

    return null;
}

export function loadConfig(path?: string): FlopsyConfig {
    if (cached) return cached;

    const configPath = findConfigFile(path);

    if (!configPath) {
        cached = flopsyConfigSchema.parse({});
        resolveWorkspacePaths(
            cached,
            resolveWorkspaceRoot(cached as unknown as Record<string, unknown>),
        );
        return cached;
    }

    let raw: string;
    try {
        raw = readFileSync(configPath, 'utf-8');
    } catch (err) {
        throw new Error(
            `Failed to read config at ${configPath}: ${err instanceof Error ? err.message : err}`,
        );
    }

    raw = resolveEnvVars(raw);

    let parsed: unknown;
    try {
        parsed = JSON5.parse(raw);
    } catch (err) {
        throw new Error(
            `Invalid JSON5 in ${configPath}: ${err instanceof Error ? err.message : err}`,
        );
    }

    warnOnLegacyProactiveKeys(parsed, configPath);

    try {
        cached = flopsyConfigSchema.parse(parsed);
    } catch (err) {
        if (err instanceof ZodError) {
            const issues = err.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
            throw new Error(`Config validation failed (${configPath}):\n${issues}`);
        }
        throw err;
    }

    resolveWorkspacePaths(
        cached,
        resolveWorkspaceRoot(cached as unknown as Record<string, unknown>),
    );

    return cached;
}

export function clearConfigCache(): void {
    cached = null;
}

function warnOnLegacyProactiveKeys(parsed: unknown, configPath: string): void {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const proactive = (parsed as Record<string, unknown>).proactive;
    if (!proactive || typeof proactive !== 'object' || Array.isArray(proactive)) return;
    const p = proactive as Record<string, unknown>;
    const legacy: string[] = [];
    const hb = p.heartbeats;
    if (hb && typeof hb === 'object' && !Array.isArray(hb) && Array.isArray((hb as Record<string, unknown>).heartbeats)) {
        legacy.push('proactive.heartbeats.heartbeats');
    }
    const sc = p.scheduler;
    if (sc && typeof sc === 'object' && !Array.isArray(sc) && Array.isArray((sc as Record<string, unknown>).jobs)) {
        legacy.push('proactive.scheduler.jobs');
    }
    if (Array.isArray(p.webhooks)) {
        legacy.push('proactive.webhooks');
    }
    if (legacy.length > 0) {
        console.warn(
            `[config] legacy proactive schedules detected in ${configPath} — already imported into proactive.db; ` +
            `remove ${legacy.join(' / ')} from flopsy.json5.`,
        );
    }
}

export function getConfigPath(explicitPath?: string): string | null {
    return findConfigFile(explicitPath);
}
