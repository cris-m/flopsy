/**
 * Convert MCP tools (JSON-Schema-described, called via the SDK) into
 * flopsygraph BaseTool instances that the ReactAgent + interceptor stack
 * already know how to invoke.
 *
 * Naming: tools land in the agent's catalog as `<server>__<toolName>`
 * to prevent collisions across servers (gmail__send vs slack__send).
 * This is opinionated — claude-code also uses double-underscore — and
 * makes telemetry/log lines self-explanatory.
 *
 * Schema shimming: MCP exposes JSON Schema; flopsygraph's defineTool
 * wants a Zod schema. We use `z.object({}).passthrough()` and let the
 * MCP server do its own validation — re-encoding JSON Schema → Zod
 * here would be ~500 lines for marginal benefit (errors land in the
 * tool result either way, framed identically).
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
    return `${server}${NAME_DELIMITER}${original}`;
}

/**
 * Stringify an MCP tool result for the agent's text-only context window.
 * MCP results are arrays of content items (text, image, resource); we
 * flatten text segments and discard binary content with a marker so the
 * model knows something was returned but not surfaced inline.
 */
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

/**
 * Wrap one MCP tool as a flopsygraph BaseTool. `manager` stays bound
 * via closure so the tool can call back into the right client when the
 * agent invokes it.
 */
export function bridgeMcpTool(
    server: string,
    tool: McpTool,
    manager: McpClientManager,
): BridgedTool {
    const name = namespacedName(server, tool.name);
    const description =
        tool.description?.trim() ||
        `MCP tool ${tool.name} from ${server} (no description provided)`;

    // Convert the MCP JSON Schema to Zod so the LLM sees real parameter types
    // (required fields, enums, descriptions). Passthrough left a `{}` schema
    // and — in practice — caused models to prefer other tools with detailed
    // schemas (http_request) over MCP tools, because the MCP tool looked
    // "unstructured" compared to competitors.
    //
    // If the inputSchema is missing or malformed, fall back to passthrough so
    // the tool is still callable (MCP server does its own validation).
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
                // No timeout override here — the client manager reads
                // per-server `callTimeoutMs` from config and falls back to
                // the 30s default. Set `mcp.servers.<name>.callTimeoutMs`
                // in flopsy.json5 for file-heavy servers (obsidian, drive).
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

/**
 * Bridge ALL tools advertised by every connected server. Returns a
 * flat array, with collisions detected and logged (NOT silently
 * deduped — surfacing them in logs nudges the operator to rename in
 * config OR drop one of the conflicting servers).
 */
export async function bridgeAllTools(manager: McpClientManager): Promise<BridgedTool[]> {
    const out: BridgedTool[] = [];
    const seen = new Set<string>();

    for (const server of manager.connectedServerNames) {
        const tools = await manager.listTools(server);
        for (const tool of tools) {
            const bridged = bridgeMcpTool(server, tool, manager);
            if (seen.has(bridged.name)) {
                // Theoretically impossible since we namespace by server,
                // but log + skip if it ever happens (e.g. server-side dup).
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
 * Filter bridged tools by a server allow-list (the team-member's
 * `mcpServers` field OR the wildcard "*" in `assignTo`).
 *
 * Resolution order, first match wins:
 *   1. agent-side `mcpServers: ["gmail", "calendar"]` → only those
 *   2. server-side `assignTo: ["gandalf"]` includes agent name → include
 *   3. server-side `assignTo: ["*"]` → include for everyone
 *   4. otherwise → skip
 *
 * Implemented by passing both signals to this function. Either may be
 * empty: empty `agentRequested` means "no preference, use assignTo";
 * empty `assignTo` means "server is opt-in, no broadcast".
 */
export function filterToolsForAgent(
    tools: readonly BridgedTool[],
    agentName: string,
    agentRequested: readonly string[] | undefined,
    serverAssignToMap: Readonly<Record<string, readonly string[]>>,
): BridgedTool[] {
    // Case-insensitive match: `assignTo: ["Sam"]` with agent `"sam"` used to
    // silently drop every tool. Compare normalised values on both sides.
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
