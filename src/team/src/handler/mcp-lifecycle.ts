import { createLogger } from '@flopsy/shared';
import type { AgentDefinition, McpConfig } from '@flopsy/shared';
import {
    McpClientManager,
    bridgeAllTools,
    filterToolsForAgent,
    loadMcpServers,
    type BridgedTool,
} from '../mcp';
import { redactSecrets } from './redact';

const log = createLogger('mcp-lifecycle');

export interface McpServerStatus {
    readonly name: string;
    readonly status: 'connected' | 'skipped' | 'failed' | 'disabled';
    readonly reason?: string;
    readonly toolCount?: number;
}

export interface McpReloadResult {
    readonly connected: string[];
    readonly skipped: Array<{ name: string; reason: string }>;
    readonly failed: Array<{ name: string; reason: string }>;
}

/**
 * Owns the MCP client manager + the boot-time tool bridge promise. Provides
 * worker-scoped server filtering and the preload partition the agent factory
 * needs at turn build time.
 *
 * Boot path:  `new McpLifecycle(cfg).initialize()` — kicks off `mcpReady`.
 * Turn path:  `await mcp.getReadyTools()` → `filterToolsForAgent(...)` →
 *             `mcp.partitionByPreload(filtered)`.
 * Shutdown:   `await mcp.close()`.
 */
export class McpLifecycle {
    private readonly manager = new McpClientManager();
    private readonly serversCfg: McpConfig['servers'];
    private readonly assignToMap: Readonly<Record<string, readonly string[]>>;
    private readonly enabled: boolean;
    private readyPromise: Promise<readonly BridgedTool[]> = Promise.resolve([]);
    private skipReasons: Readonly<Record<string, string>> = {};
    private readonly toolCounts = new Map<string, number>();

    constructor(cfg: McpConfig | undefined) {
        this.serversCfg = cfg?.servers ?? {};
        this.enabled = cfg?.enabled !== false;
        this.assignToMap = Object.fromEntries(
            Object.entries(this.serversCfg)
                .filter(([, srv]) => srv.enabled !== false)
                .map(([name, srv]) => [name, srv.assignTo ?? []]),
        );
    }

    /**
     * Kick off boot-time MCP server connect + tool bridge. Failure is
     * logged and absorbed — agents will run without MCP tools rather than
     * refusing to start. Caller awaits `getReadyTools()` lazily.
     */
    initialize(): void {
        if (!this.enabled || Object.keys(this.serversCfg).length === 0) return;
        this.readyPromise = (async () => {
            try {
                const { servers, skipped } = await loadMcpServers(this.serversCfg);
                this.skipReasons = { ...skipped };
                for (const [name, reason] of Object.entries(skipped)) {
                    log.info({ server: name, reason }, 'mcp server skipped');
                }
                if (servers.length === 0) return [];
                await this.manager.connect(servers);
                const bridged = await bridgeAllTools(this.manager);
                this.refreshToolCounts(bridged);
                return bridged;
            } catch (err) {
                log.error(
                    { err: redactSecrets(err) },
                    'mcp connect/bridge failed — agents will run without MCP tools',
                );
                return [];
            }
        })();
    }

    getReadyTools(): Promise<readonly BridgedTool[]> {
        return this.readyPromise;
    }

    getServersCfg(): McpConfig['servers'] {
        return this.serversCfg;
    }

    hasServers(): boolean {
        return Object.keys(this.serversCfg).length > 0;
    }

    /**
     * Filter a bridged-tool list down to those the agent should see, based on
     * its `mcpServers` declaration + the global `assignTo` map. Convenience
     * wrapper around `filterToolsForAgent` so callers don't need the raw map.
     */
    filterForAgent(
        allTools: readonly BridgedTool[],
        agentName: string,
        agentMcpServers: readonly string[] | undefined,
    ): BridgedTool[] {
        return filterToolsForAgent(allTools, agentName, agentMcpServers, this.assignToMap);
    }

    /** Worker → enabled MCP server names (def.mcpServers wins; otherwise assignTo map). */
    serversForWorker(def: AgentDefinition): string[] {
        const pull = def.mcpServers;
        if (pull && pull.length > 0) return [...pull];
        return Object.entries(this.assignToMap)
            .filter(([, assigned]) => assigned.includes(def.name) || assigned.includes('*'))
            .map(([name]) => name);
    }

    /**
     * Split bridged tools into preload-static vs lazy-dynamic. Preload tools
     * sit in the system prompt at boot; dynamic ones are resolved per turn.
     */
    partitionByPreload(
        tools: readonly BridgedTool[],
    ): { staticMcpTools: BridgedTool[]; dynamicMcpTools: BridgedTool[] } {
        const staticMcpTools: BridgedTool[] = [];
        const dynamicMcpTools: BridgedTool[] = [];
        for (const t of tools) {
            const cfg = this.serversCfg[t.mcpServer];
            if (cfg && cfg.preload === true) {
                staticMcpTools.push(t);
            } else {
                dynamicMcpTools.push(t);
            }
        }
        return { staticMcpTools, dynamicMcpTools };
    }

    listServers(): ReadonlyArray<McpServerStatus> {
        const out: McpServerStatus[] = [];
        const connectedSet = new Set(this.manager.connectedServerNames);
        const failedMap = this.manager.failedServers;
        const skippedMap = this.skipReasons;

        for (const [name, cfg] of Object.entries(this.serversCfg)) {
            if (cfg.enabled === false) {
                out.push({ name, status: 'disabled' });
                continue;
            }
            if (connectedSet.has(name)) {
                const tools = this.toolCounts.get(name);
                out.push({
                    name,
                    status: 'connected',
                    ...(tools !== undefined ? { toolCount: tools } : {}),
                });
                continue;
            }
            if (failedMap[name]) {
                out.push({ name, status: 'failed', reason: failedMap[name] });
                continue;
            }
            if (skippedMap[name]) {
                out.push({ name, status: 'skipped', reason: skippedMap[name] });
                continue;
            }
            out.push({ name, status: 'skipped', reason: 'never loaded' });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Reload all configured MCP servers. Returns the set newly connected
     * (after - before). Caller decides whether to evict cached threads to
     * pick up the refreshed tool list.
     */
    async reload(): Promise<McpReloadResult> {
        const beforeConnected = new Set(this.manager.connectedServerNames);

        const { servers, skipped } = await loadMcpServers(this.serversCfg);
        this.skipReasons = { ...skipped };

        if (servers.length > 0) {
            await this.manager.connect(servers);
        }

        if (this.manager.connectedServerNames.length > 0) {
            this.readyPromise = bridgeAllTools(this.manager).then((tools) => {
                this.refreshToolCounts(tools);
                return tools;
            });
            await this.readyPromise;
        }

        const afterConnected = new Set(this.manager.connectedServerNames);
        const newlyConnected = [...afterConnected].filter((n) => !beforeConnected.has(n)).sort();
        const failedAfter = this.manager.failedServers;

        return {
            connected: newlyConnected,
            skipped: Object.entries(this.skipReasons).map(([name, reason]) => ({ name, reason })),
            failed: Object.entries(failedAfter).map(([name, reason]) => ({ name, reason })),
        };
    }

    /**
     * Restart only the servers that depend on a freshly-authenticated
     * provider. Used by the `onAuthSuccess` hook so MCP refresh is scoped
     * to the affected subset, not a full reload.
     */
    async restartAfterAuth(provider: string): Promise<readonly string[]> {
        if (!this.hasServers()) return [];
        const affected = Object.entries(this.serversCfg)
            .filter(
                ([, srv]) => srv.enabled !== false && srv.requiresAuth?.includes(provider),
            )
            .map(([name]) => name);
        if (affected.length === 0) return [];

        const { servers } = await loadMcpServers(
            Object.fromEntries(affected.map((n) => [n, this.serversCfg[n]!])),
        );
        if (servers.length > 0) await this.manager.restartServers(servers);
        return affected;
    }

    async close(): Promise<void> {
        await this.manager.closeAll();
    }

    private refreshToolCounts(tools: readonly BridgedTool[]): void {
        this.toolCounts.clear();
        for (const t of tools) {
            this.toolCounts.set(t.mcpServer, (this.toolCounts.get(t.mcpServer) ?? 0) + 1);
        }
    }
}
