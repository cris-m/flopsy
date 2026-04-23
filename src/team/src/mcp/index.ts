/**
 * Public surface for MCP wiring.
 *
 * Bootstrap path:
 *   1. loadMcpServers(config.mcp.servers) → filtered + auth-injected list
 *   2. new McpClientManager().connect(loaded) → opens transports
 *   3. bridgeAllTools(manager) → flat array of flopsygraph BaseTool
 *   4. filterToolsForAgent(...) per team member at factory time
 *   5. manager.closeAll() on shutdown
 */

export { loadMcpServers } from './loader';
export type { LoadedMcpServer, LoaderResult } from './loader';

export { McpClientManager } from './client-manager';

export {
    bridgeMcpTool,
    bridgeAllTools,
    filterToolsForAgent,
} from './tool-bridge';
export type { BridgedTool } from './tool-bridge';
