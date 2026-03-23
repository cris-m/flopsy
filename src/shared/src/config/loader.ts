import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import JSON5 from 'json5';
import { ZodError } from 'zod';
import { flopsyConfigSchema, type FlopsyConfig } from './schema';

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const DEFAULT_CONFIG_PATHS = [
    'flopsy.json5',
    'flopsy.json',
];

let cached: FlopsyConfig | null = null;

function resolveEnvVars(text: string): string {
    return text.replace(ENV_VAR_PATTERN, (match, name: string) => {
        const value = process.env[name];
        if (value === undefined) return match;
        return value;
    });
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
        return cached;
    }

    let raw: string;
    try {
        raw = readFileSync(configPath, 'utf-8');
    } catch (err) {
        throw new Error(`Failed to read config at ${configPath}: ${err instanceof Error ? err.message : err}`);
    }

    raw = resolveEnvVars(raw);

    let parsed: unknown;
    try {
        parsed = JSON5.parse(raw);
    } catch (err) {
        throw new Error(`Invalid JSON5 in ${configPath}: ${err instanceof Error ? err.message : err}`);
    }

    try {
        cached = flopsyConfigSchema.parse(parsed);
    } catch (err) {
        if (err instanceof ZodError) {
            const issues = err.issues
                .map((i) => `  ${i.path.join('.')}: ${i.message}`)
                .join('\n');
            throw new Error(`Config validation failed (${configPath}):\n${issues}`);
        }
        throw err;
    }

    return cached;
}

export function clearConfigCache(): void {
    cached = null;
}

export function getConfigPath(explicitPath?: string): string | null {
    return findConfigFile(explicitPath);
}
