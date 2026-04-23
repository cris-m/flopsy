import { describe, it, expect } from 'vitest';
import type { ToolRunContext } from 'flopsygraph';
import { sendMessageTool, type SendMessageConfigurable } from '../send-message';

// ---------------------------------------------------------------------------
// Harness — invoke the tool's .run() (the full lifecycle including schema
// validation) the way the executor does in production.
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<SendMessageConfigurable> = {}): {
    ctx: ToolRunContext;
    replies: string[];
    readonly didSendCount: number;
} {
    const replies: string[] = [];
    let didSendCount = 0;
    const cfg: SendMessageConfigurable = {
        onReply: async text => {
            replies.push(text);
        },
        setDidSendViaTool: () => {
            didSendCount++;
        },
        ...overrides,
    };
    return {
        ctx: { configurable: cfg as unknown as Record<string, unknown> },
        replies,
        get didSendCount() {
            return didSendCount;
        },
    };
}

// ---------------------------------------------------------------------------

describe('sendMessageTool / name + schema', () => {
    it('has the expected tool name', () => {
        expect(sendMessageTool.name).toBe('send_message');
    });

    it('rejects empty strings at the schema layer', async () => {
        const harness = makeCtx();
        const result = await sendMessageTool.run({ text: '' }, 'call-0', harness.ctx);
        expect(result.isError).toBe(true);
        expect(result.toolName).toBe('send_message');
        expect(harness.replies).toEqual([]);
        expect(harness.didSendCount).toBe(0);
    });

    it('rejects when the text field is missing', async () => {
        const harness = makeCtx();
        const result = await sendMessageTool.run({}, 'call-0', harness.ctx);
        expect(result.isError).toBe(true);
    });
});

describe('sendMessageTool / happy path', () => {
    it('delivers text via onReply and flags the turn', async () => {
        const harness = makeCtx();
        const result = await sendMessageTool.run(
            { text: 'working on it...' },
            'call-1',
            harness.ctx,
        );
        expect(result.isError).toBe(false);
        expect(result.output).toBe('sent');
        expect(harness.replies).toEqual(['working on it...']);
        expect(harness.didSendCount).toBe(1);
    });

    it('supports multiple calls in one turn (streaming progress)', async () => {
        const harness = makeCtx();
        await sendMessageTool.run({ text: 'step 1 done' }, 'call-1', harness.ctx);
        await sendMessageTool.run({ text: 'step 2 done' }, 'call-2', harness.ctx);
        await sendMessageTool.run({ text: 'all finished' }, 'call-3', harness.ctx);
        expect(harness.replies).toEqual(['step 1 done', 'step 2 done', 'all finished']);
        expect(harness.didSendCount).toBe(3);
    });

    it('awaits async onReply implementations', async () => {
        let resolvedAt = -1;
        const harness = makeCtx({
            onReply: text => {
                return new Promise(resolve =>
                    setTimeout(() => {
                        resolvedAt = Date.now();
                        resolve();
                    }, 10),
                );
            },
        });
        const startedAt = Date.now();
        await sendMessageTool.run({ text: 'hi' }, 'c', harness.ctx);
        expect(resolvedAt).toBeGreaterThanOrEqual(startedAt);
    });
});

describe('sendMessageTool / degraded wiring', () => {
    it('no onReply: returns a safe diagnostic, never throws', async () => {
        const ctx: ToolRunContext = { configurable: {} };
        const result = await sendMessageTool.run({ text: 'hi' }, 'c', ctx);
        expect(result.isError).toBe(false);
        expect(result.output).toMatch(/no onReply/i);
    });

    it('onReply that throws: does NOT set didSendViaTool (fallback kicks in)', async () => {
        let didSendCount = 0;
        const ctx: ToolRunContext = {
            configurable: {
                onReply: () => {
                    throw new Error('boom');
                },
                setDidSendViaTool: () => {
                    didSendCount++;
                },
            },
        };
        const result = await sendMessageTool.run({ text: 'hi' }, 'c', ctx);
        expect(result.isError).toBe(false); // defineTool returns strings, not throws
        expect(result.output).toMatch(/delivery failed/i);
        expect(didSendCount).toBe(0);
    });

    it('onReply that rejects: does NOT set didSendViaTool', async () => {
        let didSendCount = 0;
        const ctx: ToolRunContext = {
            configurable: {
                onReply: async () => {
                    throw new Error('network');
                },
                setDidSendViaTool: () => {
                    didSendCount++;
                },
            },
        };
        const result = await sendMessageTool.run({ text: 'hi' }, 'c', ctx);
        expect(result.output).toMatch(/delivery failed/i);
        expect(didSendCount).toBe(0);
    });

    it('no setDidSendViaTool: delivers successfully without calling it', async () => {
        const replies: string[] = [];
        const ctx: ToolRunContext = {
            configurable: {
                onReply: async (text: string) => {
                    replies.push(text);
                },
                // setDidSendViaTool intentionally omitted
            },
        };
        const result = await sendMessageTool.run({ text: 'hi' }, 'c', ctx);
        expect(result.isError).toBe(false);
        expect(result.output).toBe('sent');
        expect(replies).toEqual(['hi']);
    });
});
