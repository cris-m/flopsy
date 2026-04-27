/**
 * MCP server config loader.
 *
 * Takes the raw `mcp.servers` block from flopsy.json5 and returns a
 * filtered, env-expanded, auth-injected list ready to feed to the
 * client manager.
 *
 * Filtering rules (server is SKIPPED when):
 *   - `enabled: false`
 *   - `platform` set and doesn't match process.platform
 *   - any `requires` env var is missing
 *   - any `requiresAuth` provider has no stored credential
 *
 * Env-var injection (in resolved order, later wins):
 *   1. process.env (inherited base)
 *   2. server.env after `${VAR}` and `${VAR:-default}` expansion
 *   3. auth tokens — `FLOPSY_<PROVIDER>_ACCESS_TOKEN` (plus refresh
 *      token + expiry) for each `requiresAuth` provider, refreshed via
 *      `getValidCredential` so children inherit the longest-lived access
 *      token we can mint.
 */

import { createLogger } from '@flopsy/shared';
import type { McpServerConfig } from '@flopsy/shared';
import { getValidCredential } from '@flopsy/cli';

const log = createLogger('mcp-loader');

export interface LoadedMcpServer {
    readonly name: string;
    readonly transport: 'stdio' | 'http' | 'sse';
    readonly command?: string;
    readonly args: readonly string[];
    readonly url?: string;
    readonly headers?: Readonly<Record<string, string>>;
    /** Final env after expansion + auth injection. NOT merged with process.env yet — */
    /** the spawn helper does that to keep this object portable. */
    readonly env: Readonly<Record<string, string>>;
    readonly assignTo: readonly string[];
    readonly description?: string;
    /** Per-server tool-call timeout override (ms). Undefined → use client default. */
    readonly callTimeoutMs?: number;
}

export interface LoaderResult {
    readonly servers: readonly LoadedMcpServer[];
    /** Map of skipped server name → reason (for /status / diagnostics). */
    readonly skipped: Readonly<Record<string, string>>;
}

/**
 * Resolve `${VAR}` and `${VAR:-default}` references against process.env.
 * Unknown vars become empty strings unless a default is provided.
 */
function expandEnvValue(raw: string): string {
    return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name, dflt) => {
        const v = process.env[name];
        if (v !== undefined && v !== '') return v;
        return dflt ?? '';
    });
}

/**
 * Filter + expand servers. Async because auth refresh may hit the network.
 */
export async function loadMcpServers(
    rawServers: Record<string, McpServerConfig>,
): Promise<LoaderResult> {
    const servers: LoadedMcpServer[] = [];
    const skipped: Record<string, string> = {};

    for (const [name, cfg] of Object.entries(rawServers)) {
        if (!cfg.enabled) {
            skipped[name] = 'disabled in config';
            continue;
        }

        if (cfg.platform && cfg.platform !== process.platform) {
            skipped[name] = `platform=${cfg.platform} (current: ${process.platform})`;
            continue;
        }

        // requires: env vars must be set
        const missingEnv = cfg.requires.filter((v) => !process.env[v]);
        if (missingEnv.length > 0) {
            skipped[name] = `missing env: ${missingEnv.join(', ')}`;
            continue;
        }

        // requiresAuth: each provider must have a stored credential.
        // We refresh now (small upfront cost) so the spawned process gets
        // a token with the longest possible runway, AND we inject the
        // full credential set so servers can refresh in-process when the
        // access token expires mid-lifetime (the MCP SDK's stdio
        // transport does not auto-respawn children).
        const authEnv: Record<string, string> = {};
        let authError: string | undefined;
        for (const providerName of cfg.requiresAuth) {
            try {
                const PREFIX = `${providerName.toUpperCase()}_`;
                const cred = await getValidCredential(providerName);
                authEnv[`${PREFIX}ACCESS_TOKEN`] = cred.accessToken;
                authEnv[`${PREFIX}EXPIRES_AT`] = String(cred.expiresAt);
                if (cred.refreshToken) {
                    authEnv[`${PREFIX}REFRESH_TOKEN`] = cred.refreshToken;
                }
            } catch (err) {
                authError = `${providerName}: ${err instanceof Error ? err.message : String(err)}`;
                break;
            }
        }
        if (authError) {
            skipped[name] = `auth: ${authError}`;
            continue;
        }

        // Expand env values, then layer auth tokens on top so server-config
        // can't accidentally shadow them.
        const expandedEnv = Object.fromEntries(
            Object.entries(cfg.env).map(([k, v]) => [k, expandEnvValue(v)]),
        );
        // Detect shadowing between the two sources — e.g. server-config sets
        // GOOGLE_ACCESS_TOKEN manually AND requiresAuth also injects it.
        // Without this warning the user sees a silent override, like the
        // real incident where a duplicate .env line masked the refresh secret.
        const shadowed = Object.keys(expandedEnv).filter((k) => k in authEnv);
        if (shadowed.length > 0) {
            log.warn(
                { server: name, keys: shadowed },
                'server.env keys overridden by requiresAuth injection',
            );
        }
        const finalEnv = { ...expandedEnv, ...authEnv };

        servers.push({
            name,
            transport: cfg.transport,
            ...(cfg.command ? { command: cfg.command } : {}),
            args: cfg.args,
            ...(cfg.url ? { url: cfg.url } : {}),
            ...(cfg.headers ? { headers: cfg.headers } : {}),
            env: finalEnv,
            assignTo: cfg.assignTo,
            ...(cfg.description ? { description: cfg.description } : {}),
            ...(cfg.callTimeoutMs ? { callTimeoutMs: cfg.callTimeoutMs } : {}),
        });
    }

    if (Object.keys(skipped).length > 0) {
        log.info({ skipped }, 'mcp servers skipped (see field for reasons)');
    }
    log.info({ enabled: servers.map((s) => s.name) }, 'mcp servers ready to connect');

    return { servers, skipped };
}
