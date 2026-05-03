/**
 * Late-bound bridge between `/mcp` and the TeamHandler MCP loader.
 * `/mcp reload` is the user-pull alternative when CLI-completed auth wrote
 * a credential without notifying the running daemon's onAuthSuccess hook.
 */

export interface McpServerStatus {
    readonly name: string;
    /**
     *   connected — live and bridged
     *   skipped   — enabled but unloadable (missing creds/env/platform)
     *   failed    — tried to connect, errored
     *   disabled  — `enabled: false` in config
     */
    readonly status: 'connected' | 'skipped' | 'failed' | 'disabled';
    readonly reason?: string;
    readonly toolCount?: number;
}

export interface ReloadResult {
    readonly connected: readonly string[];
    readonly skipped: ReadonlyArray<{ name: string; reason: string }>;
    readonly failed: ReadonlyArray<{ name: string; reason: string }>;
    /** When false, only NEW threads see the new tools. */
    readonly evictedCachedThreads: boolean;
}

export interface McpFacade {
    listServers(): readonly McpServerStatus[];
    reload(opts?: { evictCachedThreads?: boolean }): Promise<ReloadResult>;
}

let facade: McpFacade | null = null;

export function setMcpFacade(f: McpFacade | null): void {
    facade = f;
}

export function getMcpFacade(): McpFacade | null {
    return facade;
}
