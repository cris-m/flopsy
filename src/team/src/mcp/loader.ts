/**
 * Filter + expand + auth-inject mcp.servers config for the client manager.
 * Skip rules: enabled=false; platform mismatch; missing `requires` env; failed `requiresAuth`.
 */

import { createLogger, resolveSecret } from '@flopsy/shared';
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

/**
 * Resolve `${VAR}` and `${VAR:-default}`.
 *
 * Lookup chain (vault-optional design):
 *   1. resolveSecret(name) — handles both plaintext env values AND vault
 *      placeholder resolution. Returns undefined if neither has the value.
 *   2. Default fallback from `${VAR:-default}` syntax.
 *
 * When vault is not running, resolveSecret transparently falls back to
 * process.env[name], so flopsy works in both modes.
 */
function expandEnvValue(raw: string): string {
    return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name, dflt) => {
        const v = resolveSecret(name);
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

        // Resolve `requires` env vars via vault-aware lookup. Each MCP child
        // that needs e.g. GOOGLE_CLIENT_SECRET gets the REAL value injected
        // into its env at spawn time — scoped to that one child, not in the
        // daemon's process.env.
        //
        // Vault-optional: if vault is unreachable, resolveSecret falls back
        // to whatever process.env has (which is fine for plaintext .env users).
        // Only fails the gate if BOTH env and vault have nothing.
        const requiredValues: Record<string, string> = {};
        const missingEnv: string[] = [];
        for (const v of cfg.requires) {
            const resolved = resolveSecret(v);
            if (resolved && resolved.length > 0) {
                requiredValues[v] = resolved;
            } else {
                missingEnv.push(v);
            }
        }
        if (missingEnv.length > 0) {
            skipped[name] = `missing env: ${missingEnv.join(', ')}`;
            continue;
        }

        // Refresh now so spawned children inherit the longest runway. Inject
        // refresh tokens too so servers can refresh in-process (the MCP SDK
        // doesn't auto-respawn stdio children).
        const GOOGLE_SERVICES = new Set(['gmail', 'drive', 'calendar', 'youtube', 'contacts', 'google']);
        const envPrefixFor = (providerName: string): string =>
            GOOGLE_SERVICES.has(providerName) ? 'GOOGLE_' : `${providerName.toUpperCase()}_`;

        const authEnv: Record<string, string> = {};
        let authError: string | undefined;
        for (const providerName of cfg.requiresAuth) {
            try {
                const PREFIX = envPrefixFor(providerName);
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

        // Env layering for the MCP child process. Order is important:
        //   1. expandedEnv — explicit env: {} block from config, ${VAR}-expanded
        //   2. requiredValues — auto-injected from cfg.requires (vault-resolved)
        //   3. authEnv — refreshed OAuth tokens
        // Later layers override earlier ones; auth tokens always win.
        //
        // The child gets ONLY the env vars it needs (scope = cfg.requires + cfg.env
        // + auth). It does NOT inherit the daemon's full process.env.
        const expandedEnv = Object.fromEntries(
            Object.entries(cfg.env).map(([k, v]) => [k, expandEnvValue(v)]),
        );
        const shadowedByAuth = Object.keys({ ...expandedEnv, ...requiredValues }).filter((k) => k in authEnv);
        if (shadowedByAuth.length > 0) {
            log.warn(
                { server: name, keys: shadowedByAuth },
                'env keys overridden by requiresAuth injection',
            );
        }
        const finalEnv = { ...expandedEnv, ...requiredValues, ...authEnv };

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
