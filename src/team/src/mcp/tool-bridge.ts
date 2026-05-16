/**
 * Convert MCP tools into flopsygraph BaseTool instances.
 * Names are namespaced as `<server>__<toolName>` to prevent cross-server collisions.
 */

import { z } from 'zod';
import { defineTool, jsonSchemaToZod, type BaseTool } from 'flopsygraph';
import { createLogger } from '@flopsy/shared';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { McpClientManager, NormalisedCallToolResult } from './client-manager';

const log = createLogger('mcp-bridge');

const NAME_DELIMITER = '__';
const MAX_RESULT_CHARS = 50_000;

export interface BridgedTool extends BaseTool {
    /** Server that owns this tool — for diagnostics + assignTo routing. */
    readonly mcpServer: string;
    /** Original tool name as the server reported it (sans server prefix). */
    readonly mcpOriginalName: string;
}

function namespacedName(server: string, original: string): string {
    // Skip the prefix when the upstream name already starts with it
    // (gmail__gmail_search would confuse LLMs that guess `gmail_search`).
    const normalized = original.toLowerCase();
    const prefix = server.toLowerCase();
    if (normalized.startsWith(prefix + '_') || normalized.startsWith(prefix + NAME_DELIMITER)) {
        return original;
    }
    return `${server}${NAME_DELIMITER}${original}`;
}

/** Flatten content items to text; binary content gets a placeholder marker. */
function flattenResult(result: NormalisedCallToolResult): string {
    if (!result.content || result.content.length === 0) {
        return result.isError ? '(error: no content returned)' : '(no content)';
    }
    const parts: string[] = [];
    for (const item of result.content) {
        if (item.type === 'text' && typeof item.text === 'string') {
            parts.push(item.text);
        } else if (item.type === 'image') {
            parts.push(`[image: mimeType=${item.mimeType ?? 'unknown'}, omitted from text]`);
        } else if (item.type === 'resource' && item.resource) {
            if (item.resource.text) parts.push(item.resource.text);
            else parts.push(`[resource: uri=${item.resource.uri ?? 'unknown'}, omitted]`);
        } else {
            parts.push(`[unknown content type: ${item.type}]`);
        }
    }
    let joined = parts.join('\n');
    if (joined.length > MAX_RESULT_CHARS) {
        joined = joined.slice(0, MAX_RESULT_CHARS) + '\n[truncated — exceeded result size limit]';
    }
    return result.isError ? `MCP tool error: ${joined}` : joined;
}

/** Wrap one MCP tool as a flopsygraph BaseTool with the manager bound via closure. */
export function bridgeMcpTool(
    server: string,
    tool: McpTool,
    manager: McpClientManager,
): BridgedTool {
    const name = namespacedName(server, tool.name);
    const description =
        tool.description?.trim() ||
        `MCP tool ${tool.name} from ${server} (no description provided)`;

    // Convert MCP JSON Schema → Zod so the LLM sees real parameter types.
    // Falls back to passthrough on missing/malformed schema (MCP server validates server-side).
    const rawSchema = tool.inputSchema as Record<string, unknown> | undefined;
    let toolSchema: z.ZodType<Record<string, unknown>>;
    try {
        toolSchema = rawSchema
            ? (jsonSchemaToZod(rawSchema) as z.ZodType<Record<string, unknown>>)
            : z.object({}).passthrough();
    } catch (err) {
        log.warn(
            { server, tool: tool.name, err: err instanceof Error ? err.message : String(err) },
            'failed to convert MCP inputSchema to Zod — falling back to passthrough',
        );
        toolSchema = z.object({}).passthrough();
    }

    const wrapped = defineTool({
        name,
        description,
        schema: toolSchema,
        execute: async (args) => {
            try {
                // Client manager reads per-server `callTimeoutMs` from config (30s default).
                const result = await manager.callTool(
                    server, tool.name, args as Record<string, unknown>,
                );
                return flattenResult(result);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn({ server, tool: tool.name, err: msg }, 'mcp tool call failed');
                return `MCP call to ${name} failed: ${msg}`;
            }
        },
    });

    return Object.assign(wrapped as BridgedTool, {
        mcpServer: server,
        mcpOriginalName: tool.name,
    });
}

/** Bridge ALL connected servers' tools; collisions are logged + skipped. */
export async function bridgeAllTools(manager: McpClientManager): Promise<BridgedTool[]> {
    const out: BridgedTool[] = [];
    const seen = new Set<string>();

    for (const server of manager.connectedServerNames) {
        const tools = await manager.listTools(server);
        for (const tool of tools) {
            const bridged = bridgeMcpTool(server, tool, manager);
            if (seen.has(bridged.name)) {
                log.warn(
                    { name: bridged.name, server },
                    'duplicate bridged tool name — skipping second',
                );
                continue;
            }
            seen.add(bridged.name);
            out.push(bridged);
        }
    }
    log.info({ total: out.length, servers: manager.connectedServerNames }, 'mcp tools bridged');
    return out;
}

/**
 * Filter by allow-list (agent's `mcpServers` first; else server-side `assignTo`).
 * Empty `agentRequested` → use assignTo; empty `assignTo` → opt-in only.
 */
export function filterToolsForAgent(
    tools: readonly BridgedTool[],
    agentName: string,
    agentRequested: readonly string[] | undefined,
    serverAssignToMap: Readonly<Record<string, readonly string[]>>,
): BridgedTool[] {
    // Case-insensitive match — `assignTo: ["Sam"]` vs agent `"sam"` would otherwise drop.
    const needle = agentName.trim().toLowerCase();
    if (agentRequested && agentRequested.length > 0) {
        const set = new Set(agentRequested.map((n) => n.trim().toLowerCase()));
        return tools.filter((t) => set.has(t.mcpServer.toLowerCase()));
    }
    return tools.filter((t) => {
        const assigned = serverAssignToMap[t.mcpServer] ?? [];
        return assigned.some((a) => {
            const n = a.trim().toLowerCase();
            return n === needle || n === '*';
        });
    });
}
