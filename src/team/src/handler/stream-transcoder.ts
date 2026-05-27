import type { AgentChunk } from '@flopsy/gateway';

export type FlopsyStreamChunk = {
    content?: string;
    reasoning?: string;
    toolCallDeltas?: Array<{ index: number; id?: string; name?: string; args?: string }>;
};

export type ChunkEvent = { type: 'message-chunk'; chunk?: FlopsyStreamChunk };
export type NodeEvent = {
    type: 'node-start' | 'node-finish';
    node: string;
    updates?: Record<string, unknown>;
};
export type ResultEvent = { type: 'result'; data?: { state?: unknown } };
export type AgentStreamEvent = ChunkEvent | NodeEvent | ResultEvent | { type: string };

export interface AgentStreamHandle {
    stream(
        input: { messages: Array<{ role: string; content: unknown }> },
        opts: { threadId: string; signal: AbortSignal; configurable: Record<string, unknown> },
    ): AsyncIterable<AgentStreamEvent>;
}

/**
 * Drain a flopsygraph agent stream, translating message-chunks, tool-call
 * deltas, and node lifecycle events into `onChunk` callbacks. Returns the
 * `result` event's state payload. Caller asserts non-null and narrows.
 *
 * Tool-call deltas arrive split: the first delta carries `name` + `index`,
 * later deltas carry partial JSON args. We accumulate args by index, emit
 * `tool_start` on the matching `tools` node-start (now that args are
 * complete), and emit `tool_result` on node-finish.
 *
 * Pure consumer — no instance state, no side effects outside `onChunk`.
 * Exceptions thrown by `onChunk` are swallowed (preview path is best-effort).
 */
export async function transcodeAgentStream(
    stream: AsyncIterable<AgentStreamEvent>,
    onChunk?: (chunk: AgentChunk) => void,
): Promise<unknown> {
    let lastToolName: string | undefined;
    let lastToolIndex: number | undefined;
    const toolArgsByIndex = new Map<number, string>();
    let resultState: unknown = null;

    const emit = (chunk: AgentChunk): void => {
        if (!onChunk) return;
        try {
            onChunk(chunk);
        } catch {
            /* preview path is best-effort */
        }
    };

    for await (const event of stream) {
        if (event.type === 'message-chunk') {
            const c = (event as ChunkEvent).chunk;
            if (!c) continue;
            if (c.content) emit({ type: 'text_delta', text: c.content });
            if (c.reasoning) emit({ type: 'thinking', text: c.reasoning });
            if (c.toolCallDeltas) {
                for (const d of c.toolCallDeltas) {
                    if (d.name) {
                        lastToolName = d.name;
                        lastToolIndex = d.index;
                    }
                    if (d.args !== undefined) {
                        const prev = toolArgsByIndex.get(d.index) ?? '';
                        toolArgsByIndex.set(d.index, prev + d.args);
                    }
                }
            }
        } else if (event.type === 'node-start') {
            if ((event as NodeEvent).node === 'tools' && lastToolName) {
                const args =
                    lastToolIndex !== undefined ? toolArgsByIndex.get(lastToolIndex) : undefined;
                emit({
                    type: 'tool_start',
                    toolName: lastToolName,
                    ...(args ? { args } : {}),
                });
            }
        } else if (event.type === 'node-finish') {
            if ((event as NodeEvent).node === 'tools' && lastToolName) {
                emit({ type: 'tool_result', toolName: lastToolName });
                if (lastToolIndex !== undefined) toolArgsByIndex.delete(lastToolIndex);
                lastToolName = undefined;
                lastToolIndex = undefined;
            }
        } else if (event.type === 'result') {
            resultState = (event as ResultEvent).data?.state;
        }
    }

    return resultState;
}
