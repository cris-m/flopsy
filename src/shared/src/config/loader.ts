import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve, isAbsolute } from 'path';
import JSON5 from 'json5';
import { ZodError } from 'zod';
import { flopsyConfigSchema, type FlopsyConfig } from './schema';
import { resolveFlopsyHome } from '../utils/workspace';

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const PATH_KEY_RE = /(path|dir|file)$/i;

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
        if (typeof value === 'string' && PATH_KEY_RE.test(key)) {
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

export function getConfigPath(explicitPath?: string): string | null {
    return findConfigFile(explicitPath);
}
