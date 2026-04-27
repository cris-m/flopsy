/**
 * MCP client manager — owns one Client per loaded server, lazily
 * connected on first tool-list request.
 *
 * Lifecycle:
 *   - `connect(servers)` opens transports + initialize handshakes in
 *     parallel; failures are isolated (one bad server doesn't poison the
 *     others; it just lands in `failed`).
 *   - `listTools(server)` returns the server's tool definitions on
 *     demand; cached after first call.
 *   - `callTool(server, name, args)` proxies to the server.
 *   - `closeAll()` — graceful shutdown on process teardown.
 *
 * Currently supports stdio only. http / sse paths throw "not yet
 * supported" errors — wire when an actual server needs them.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@flopsy/shared';
import type { LoadedMcpServer } from './loader';

/**
 * MCP `callTool` returns a union — modern shape with `content[]` plus a
 * deprecated `toolResult` variant. We narrow to the modern shape (the
 * tool-bridge expects it). Spec compliance: every server we'd ship with
 * uses the new shape; defensive narrowing rejects the deprecated path
 * with a clear error.
 */
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

    /**
     * Open clients for every server in parallel. Returns when all
     * settle (success or fail). Idempotent — already-connected servers
     * are skipped.
     */
    async connect(servers: readonly LoadedMcpServer[]): Promise<void> {
        const toConnect = servers.filter((s) => !this.clients.has(s.name));
        if (toConnect.length === 0) return;

        // allSettled ensures we don't throw on a single bad server —
        // failures are captured in `this.failed` by the inner catch.
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

        // Build the transport with merged env: process.env first (so
        // PATH etc. is available), then server-specific env on top.
        // SDK's stdio transport spawns the child for us.
        const transport = new StdioClientTransport({
            command: server.command,
            args: [...server.args],
            env: { ...(process.env as Record<string, string>), ...server.env },
        });

        const client = new Client(
            {
                name: 'flopsybot',
                version: '1.0.0',
            },
            {
                capabilities: {},
            },
        );

        // Race the connect against a timeout — slow MCP servers are common
        // (npm install on first run, model loads, etc.) so 30s is generous.
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

    /**
     * Default per-call timeout for `callTool()`. Guards against a hung MCP
     * server indefinitely blocking a turn. Callers can override per-invocation.
     */
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
        // Resolution order: per-call override → per-server config → global default.
        // callTimeoutMs === 0 means "no timeout" — we just await the call.
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
            // Clear the timeout on both resolve and reject paths — otherwise every
            // successful tool call leaves a pending timer behind for `timeoutMs`,
            // pinning the event loop and delaying graceful shutdown under load.
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

    /**
     * Look up which server owns a tool by name. Returns undefined when
     * the tool isn't registered (collisions resolve to first hit; we log
     * a warning on collision detection during the build step).
     */
    findServerForTool(toolName: string): string | undefined {
        for (const [server, entry] of this.clients) {
            if (entry.tools?.some((t) => t.name === toolName)) return server;
        }
        return undefined;
    }

    /**
     * Restart specific servers by name — closes the old client (kills the
     * child process), then reconnects with freshly-loaded server configs.
     *
     * Use this after OAuth credentials are saved so the new process spawns
     * with the updated access/refresh tokens rather than the stale ones
     * that were baked into the old child's env at startup.
     */
    async restartServers(servers: readonly LoadedMcpServer[]): Promise<void> {
        const names = servers.map((s) => s.name);
        log.info({ servers: names }, 'restarting mcp servers after auth update');

        // Close old clients — this kills the stdio child processes.
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

        // Re-connect with fresh credentials already baked into LoadedMcpServer.env.
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
