/**
 * MCP client manager — one Client per loaded server, lazy listTools cache.
 * stdio only today; http/sse paths throw "not yet supported".
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@flopsy/shared';
import type { LoadedMcpServer } from './loader';

/** Narrowed to the modern shape (`content[]`); deprecated `toolResult` is folded to a text item. */
export interface NormalisedCallToolResult {
    readonly content: ReadonlyArray<{
        readonly type: string;
        readonly text?: string;
        readonly mimeType?: string;
        readonly resource?: { readonly uri?: string; readonly text?: string };
    }>;
    readonly isError?: boolean;
}

const log = createLogger('mcp-client');

const CONNECT_TIMEOUT_MS = 30_000;

interface ClientEntry {
    readonly server: LoadedMcpServer;
    readonly client: Client;
    /** Tools cache — populated on first listTools call. */
    tools?: readonly McpTool[];
}

export class McpClientManager {
    private readonly clients = new Map<string, ClientEntry>();
    private readonly failed = new Map<string, string>();

    get connectedServerNames(): string[] {
        return Array.from(this.clients.keys()).sort();
    }

    get failedServers(): Readonly<Record<string, string>> {
        return Object.fromEntries(this.failed);
    }

    /** Open clients in parallel; idempotent. Failures land in `this.failed`. */
    async connect(servers: readonly LoadedMcpServer[]): Promise<void> {
        const toConnect = servers.filter((s) => !this.clients.has(s.name));
        if (toConnect.length === 0) return;

        await Promise.allSettled(
            toConnect.map(async (server) => {
                const startedAt = Date.now();
                try {
                    const entry = await this.connectOne(server);
                    this.clients.set(server.name, entry);
                    log.info(
                        { server: server.name, durationMs: Date.now() - startedAt },
                        'mcp client connected',
                    );
                    return server.name;
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.failed.set(server.name, message);
                    log.warn(
                        { server: server.name, err: message, durationMs: Date.now() - startedAt },
                        'mcp client connect failed',
                    );
                    throw err;
                }
            }),
        );
    }

    private async connectOne(server: LoadedMcpServer): Promise<ClientEntry> {
        if (server.transport !== 'stdio') {
            throw new Error(
                `MCP transport "${server.transport}" not yet supported — only stdio works today`,
            );
        }
        if (!server.command) {
            throw new Error(`MCP server "${server.name}" has no command`);
        }

        // Scoped env (default-deny). Inheriting `process.env` would leak FLOPSY_MGMT_TOKEN,
        // OAuth refresh tokens, and API keys into every MCP child. Allowlist below covers
        // safe shell vars; server-specific `env` is layered on top.
        const ENV_ALLOWLIST = [
            'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
            'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
            'TERM', 'COLORTERM',
            'TMPDIR', 'TEMP', 'TMP',
            'NODE_PATH', 'NVM_DIR',
            // FLOPSY_HOME lets MCPs locate the workspace; NOT the management token.
            'FLOPSY_HOME',
        ];
        const scopedEnv: Record<string, string> = {};
        for (const key of ENV_ALLOWLIST) {
            const v = process.env[key];
            if (typeof v === 'string') scopedEnv[key] = v;
        }
        // Server-specific env wins on collision.
        Object.assign(scopedEnv, server.env);

        const transport = new StdioClientTransport({
            command: server.command,
            args: [...server.args],
            env: scopedEnv,
        });

        // Contain transport errors (EPIPE etc.); without this a crashing MCP kills the gateway.
        transport.onerror = (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            log.warn({ server: server.name, err: message }, 'mcp transport error (contained)');
            this.failed.set(server.name, message);
            this.clients.delete(server.name);
        };
        transport.onclose = () => {
            // Close after connect = child died; mark failed so callers get a clean error.
            if (this.clients.has(server.name)) {
                log.warn({ server: server.name }, 'mcp transport closed unexpectedly (contained)');
                this.failed.set(server.name, 'transport closed unexpectedly');
                this.clients.delete(server.name);
            }
        };

        const client = new Client(
            {
                name: 'flopsybot',
                version: '1.0.0',
            },
            {
                capabilities: {},
            },
        );

        // 30s timeout — generous for first-run npm installs and model loads.
        await this.withTimeout(
            client.connect(transport),
            CONNECT_TIMEOUT_MS,
            `connect "${server.name}" timed out after ${CONNECT_TIMEOUT_MS}ms`,
        );

        return { server, client };
    }

    async listTools(serverName: string): Promise<readonly McpTool[]> {
        const entry = this.clients.get(serverName);
        if (!entry) {
            throw new Error(`MCP server "${serverName}" not connected`);
        }
        if (entry.tools) return entry.tools;

        const res = await entry.client.listTools();
        entry.tools = res.tools;
        return entry.tools;
    }

    /** Default per-call timeout; callers can override per-invocation. */
    private static readonly DEFAULT_CALL_TIMEOUT_MS = 30_000;

    async callTool(
        serverName: string,
        toolName: string,
        args: Record<string, unknown>,
        options?: { timeoutMs?: number },
    ): Promise<NormalisedCallToolResult> {
        const entry = this.clients.get(serverName);
        if (!entry) {
            throw new Error(`MCP server "${serverName}" not connected`);
        }
        // Resolution: per-call → per-server → global default. 0 = no timeout.
        const timeoutMs =
            options?.timeoutMs ??
            entry.server.callTimeoutMs ??
            McpClientManager.DEFAULT_CALL_TIMEOUT_MS;

        let raw: { content?: NormalisedCallToolResult['content']; isError?: boolean } | { toolResult?: unknown };
        if (timeoutMs <= 0) {
            raw = (await entry.client.callTool({ name: toolName, arguments: args })) as
                | { content?: NormalisedCallToolResult['content']; isError?: boolean }
                | { toolResult?: unknown };
        } else {
            // Clear the timer on both resolve + reject paths so successful calls don't leak timers.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(
                        `MCP callTool("${serverName}.${toolName}") timed out after ${timeoutMs}ms`,
                    )),
                    timeoutMs,
                );
                timer.unref?.();
            });
            try {
                raw = (await Promise.race([
                    entry.client.callTool({ name: toolName, arguments: args }),
                    timeoutPromise,
                ])) as
                    | { content?: NormalisedCallToolResult['content']; isError?: boolean }
                    | { toolResult?: unknown };
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
        if ('content' in raw && Array.isArray(raw.content)) {
            return { content: raw.content, ...(raw.isError ? { isError: true } : {}) };
        }
        // Deprecated shape — wrap as a single text item for the bridge.
        const fallback = (raw as { toolResult?: unknown }).toolResult;
        return {
            content: [
                { type: 'text', text: typeof fallback === 'string' ? fallback : JSON.stringify(fallback) },
            ],
        };
    }

    /** Returns the first server that owns the named tool; undefined when unregistered. */
    findServerForTool(toolName: string): string | undefined {
        for (const [server, entry] of this.clients) {
            if (entry.tools?.some((t) => t.name === toolName)) return server;
        }
        return undefined;
    }

    /** Closes + reconnects named servers; use after OAuth refresh so children inherit new tokens. */
    async restartServers(servers: readonly LoadedMcpServer[]): Promise<void> {
        const names = servers.map((s) => s.name);
        log.info({ servers: names }, 'restarting mcp servers after auth update');

        await Promise.allSettled(
            names.map(async (name) => {
                const entry = this.clients.get(name);
                if (!entry) return;
                try {
                    await entry.client.close();
                } catch (err) {
                    log.warn(
                        { server: name, err: err instanceof Error ? err.message : String(err) },
                        'mcp restart: close failed (non-fatal)',
                    );
                }
                this.clients.delete(name);
                this.failed.delete(name);
            }),
        );

        await this.connect(servers);
    }

    async closeAll(): Promise<void> {
        const closes = Array.from(this.clients.values()).map(async (entry) => {
            try {
                await entry.client.close();
            } catch (err) {
                log.warn(
                    { server: entry.server.name, err: err instanceof Error ? err.message : String(err) },
                    'mcp client close failed (non-fatal)',
                );
            }
        });
        await Promise.allSettled(closes);
        this.clients.clear();
    }

    private withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(msg)), ms);
            promise.then(
                (v) => {
                    clearTimeout(t);
                    resolve(v);
                },
                (e) => {
                    clearTimeout(t);
                    reject(e instanceof Error ? e : new Error(String(e)));
                },
            );
        });
    }
}
