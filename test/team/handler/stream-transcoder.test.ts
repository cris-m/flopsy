import { describe, it, expect } from 'vitest';
import type { AgentChunk } from '@flopsy/gateway';
import {
    transcodeAgentStream,
    type AgentStreamEvent,
} from '../../../src/team/src/handler/stream-transcoder';

async function* asStream(events: AgentStreamEvent[]): AsyncIterable<AgentStreamEvent> {
    for (const e of events) yield e;
}

describe('transcodeAgentStream', () => {
    it('emits text_delta on message-chunk.content', async () => {
        const chunks: AgentChunk[] = [];
        await transcodeAgentStream(
            asStream([
                { type: 'message-chunk', chunk: { content: 'hello' } },
                { type: 'message-chunk', chunk: { content: ' world' } },
                { type: 'result', data: { state: { messages: [] } } },
            ]),
            (c) => chunks.push(c),
        );
        expect(chunks).toEqual([
            { type: 'text_delta', text: 'hello' },
            { type: 'text_delta', text: ' world' },
        ]);
    });

    it('emits thinking on message-chunk.reasoning', async () => {
        const chunks: AgentChunk[] = [];
        await transcodeAgentStream(
            asStream([
                { type: 'message-chunk', chunk: { reasoning: 'thinking out loud' } },
                { type: 'result', data: { state: {} } },
            ]),
            (c) => chunks.push(c),
        );
        expect(chunks).toEqual([{ type: 'thinking', text: 'thinking out loud' }]);
    });

    it('accumulates tool args across deltas and emits tool_start with full args', async () => {
        const chunks: AgentChunk[] = [];
        await transcodeAgentStream(
            asStream([
                { type: 'message-chunk', chunk: { toolCallDeltas: [{ index: 0, name: 'search' }] } },
                {
                    type: 'message-chunk',
                    chunk: { toolCallDeltas: [{ index: 0, args: '{"q":"' }] },
                },
                {
                    type: 'message-chunk',
                    chunk: { toolCallDeltas: [{ index: 0, args: 'hello"}' }] },
                },
                { type: 'node-start', node: 'tools' },
                { type: 'node-finish', node: 'tools' },
                { type: 'result', data: { state: {} } },
            ]),
            (c) => chunks.push(c),
        );
        expect(chunks).toEqual([
            { type: 'tool_start', toolName: 'search', args: '{"q":"hello"}' },
            { type: 'tool_result', toolName: 'search' },
        ]);
    });

    it('emits tool_start without args when args are absent', async () => {
        const chunks: AgentChunk[] = [];
        await transcodeAgentStream(
            asStream([
                { type: 'message-chunk', chunk: { toolCallDeltas: [{ index: 0, name: 'ping' }] } },
                { type: 'node-start', node: 'tools' },
                { type: 'node-finish', node: 'tools' },
                { type: 'result', data: { state: {} } },
            ]),
            (c) => chunks.push(c),
        );
        expect(chunks).toEqual([
            { type: 'tool_start', toolName: 'ping' },
            { type: 'tool_result', toolName: 'ping' },
        ]);
    });

    it('ignores node-start / node-finish for non-tool nodes', async () => {
        const chunks: AgentChunk[] = [];
        await transcodeAgentStream(
            asStream([
                { type: 'message-chunk', chunk: { toolCallDeltas: [{ index: 0, name: 'foo' }] } },
                { type: 'node-start', node: 'agent' },
                { type: 'node-finish', node: 'agent' },
                { type: 'result', data: { state: {} } },
            ]),
            (c) => chunks.push(c),
        );
        expect(chunks).toEqual([]);
    });

    it('returns the resultState from the result event', async () => {
        const state = { messages: [{ role: 'assistant', content: 'hi' }] };
        const result = await transcodeAgentStream(
            asStream([{ type: 'result', data: { state } }]),
        );
        expect(result).toBe(state);
    });

    it('returns null when no result event was emitted', async () => {
        const result = await transcodeAgentStream(
            asStream([{ type: 'message-chunk', chunk: { content: 'oops' } }]),
        );
        expect(result).toBeNull();
    });

    it('swallows onChunk errors (preview path is best-effort)', async () => {
        let called = 0;
        await transcodeAgentStream(
            asStream([
                { type: 'message-chunk', chunk: { content: 'a' } },
                { type: 'message-chunk', chunk: { content: 'b' } },
                { type: 'result', data: { state: {} } },
            ]),
            () => {
                called += 1;
                throw new Error('preview blew up');
            },
        );
        expect(called).toBe(2);
    });

    it('works without an onChunk callback (events still consumed, resultState captured)', async () => {
        const result = await transcodeAgentStream(
            asStream([
                { type: 'message-chunk', chunk: { content: 'silent path' } },
                { type: 'result', data: { state: 'OK' } },
            ]),
        );
        expect(result).toBe('OK');
    });

    it('resets tool tracking after node-finish so a second tool call works', async () => {
        const chunks: AgentChunk[] = [];
        await transcodeAgentStream(
            asStream([
                { type: 'message-chunk', chunk: { toolCallDeltas: [{ index: 0, name: 'first' }] } },
                { type: 'node-start', node: 'tools' },
                { type: 'node-finish', node: 'tools' },
                {
                    type: 'message-chunk',
                    chunk: { toolCallDeltas: [{ index: 1, name: 'second', args: '{}' }] },
                },
                { type: 'node-start', node: 'tools' },
                { type: 'node-finish', node: 'tools' },
                { type: 'result', data: { state: {} } },
            ]),
            (c) => chunks.push(c),
        );
        expect(chunks).toEqual([
            { type: 'tool_start', toolName: 'first' },
            { type: 'tool_result', toolName: 'first' },
            { type: 'tool_start', toolName: 'second', args: '{}' },
            { type: 'tool_result', toolName: 'second' },
        ]);
    });
});
