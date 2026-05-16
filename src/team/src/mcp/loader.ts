/**
 * Filter + expand + auth-inject mcp.servers config for the client manager.
 * Skip rules: enabled=false; platform mismatch; missing `requires` env; failed `requiresAuth`.
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
    /** Expanded + auth-injected env. NOT merged with process.env (spawn helper does that). */
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

/** Resolve `${VAR}` and `${VAR:-default}` against process.env. */
function expandEnvValue(raw: string): string {
    return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name, dflt) => {
        const v = process.env[name];
        if (v !== undefined && v !== '') return v;
        return dflt ?? '';
    });
}

/** Async because auth refresh may hit the network. */
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

        const missingEnv = cfg.requires.filter((v) => !process.env[v]);
        if (missingEnv.length > 0) {
            skipped[name] = `missing env: ${missingEnv.join(', ')}`;
            continue;
        }

        // Refresh now so spawned children inherit the longest runway. Inject
        // refresh tokens too so servers can refresh in-process (the MCP SDK
        // doesn't auto-respawn stdio children).
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

        // Auth tokens layered LAST so server.env can't shadow them.
        const expandedEnv = Object.fromEntries(
            Object.entries(cfg.env).map(([k, v]) => [k, expandEnvValue(v)]),
        );
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
