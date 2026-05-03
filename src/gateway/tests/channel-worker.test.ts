import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChannelWorker } from '../src/core/channel-worker';
import type { AgentHandler, AgentResult, AgentCallbacks } from '../src/types/agent';
import type { Channel, Message, Peer } from '../src/types';

function createMockChannel(name = 'test'): Channel {
    return {
        name,
        status: 'connected',
        enabled: true,
        dmPolicy: 'open',
        groupPolicy: 'disabled',
        authType: 'token',
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue('msg-1'),
        sendTyping: vi.fn().mockResolvedValue(undefined),
        react: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        off: vi.fn(),
    };
}

function createMockHandler(reply: string | null = 'Hello!'): AgentHandler {
    return {
        invoke: vi.fn().mockResolvedValue({
            reply,
            didSendViaTool: false,
        } satisfies AgentResult),
    };
}

function createMessage(body: string, channelName = 'test'): Message {
    return {
        id: `msg-${Date.now()}`,
        channelName,
        peer: { id: 'user-1', type: 'user', name: 'Test' },
        sender: { id: 'user-1', name: 'Test' },
        body,
        timestamp: new Date().toISOString(),
    };
}

describe('ChannelWorker', () => {
    let worker: ChannelWorker;
    let channel: Channel;
    let handler: AgentHandler;
    let replies: { text: string; peer: Peer; replyTo?: string }[];

    beforeEach(() => {
        channel = createMockChannel();
        handler = createMockHandler();
        replies = [];

        worker = new ChannelWorker({
            channel,
            threadId: 'test',
            agentHandler: handler,
            onReply: async (text, peer, replyTo) => {
                replies.push({ text, peer, replyTo });
            },
            coalesceDelayMs: 0,
        });
    });

    afterEach(async () => {
        await worker.stop();
    });

    it('should start and stop cleanly', async () => {
        worker.start();
        expect(worker.isRunning).toBe(true);
        await worker.stop();
        expect(worker.isRunning).toBe(false);
    });

    it('should not start twice', () => {
        worker.start();
        worker.start();
        expect(worker.isRunning).toBe(true);
    });

    it('should dispatch message and invoke agent', async () => {
        worker.start();
        worker.dispatch(createMessage('hello'));

        await sleep(200);

        // invoke signature: (text, threadId, callbacks, role, media?)
        // The 5th arg (media) is undefined for text-only dispatches.
        const call = (handler.invoke as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(call[0]).toBe('hello');
        expect(call[1]).toBe('test');
        expect(call[2]).toEqual(
            expect.objectContaining({
                onReply: expect.any(Function),
                setDidSendViaTool: expect.any(Function),
                signal: expect.any(AbortSignal),
            }),
        );
        expect(call[3]).toBe('user');
    });

    it('should send reply when agent returns text', async () => {
        worker.start();
        worker.dispatch(createMessage('hello'));

        await sleep(200);

        expect(replies).toHaveLength(1);
        expect(replies[0].text).toBe('Hello!');
    });

    it('should not send reply when agent sent via tool', async () => {
        handler = {
            invoke: vi.fn().mockResolvedValue({
                reply: 'internal closure',
                didSendViaTool: true,
            } satisfies AgentResult),
        };

        worker = new ChannelWorker({
            channel,
            threadId: 'test',
            agentHandler: handler,
            onReply: async (text, peer) => {
                replies.push({ text, peer });
            },
            coalesceDelayMs: 0,
        });

        worker.start();
        worker.dispatch(createMessage('build api'));

        await sleep(200);

        expect(replies).toHaveLength(0);
    });

    it('should send typing before agent call', async () => {
        worker.start();
        worker.dispatch(createMessage('hello'));

        await sleep(200);

        expect(channel.sendTyping).toHaveBeenCalled();
    });

    it('should handle abort words', async () => {
        worker.start();
        worker.dispatch(createMessage('hello'));
        await sleep(50);

        worker.dispatch(createMessage('stop'));
        await sleep(200);

        const stopReplies = replies.filter((r) => r.text === 'Stopped.');
        expect(stopReplies.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle background task events', async () => {
        worker.start();
        worker.dispatch(createMessage('hello'));
        await sleep(200);

        worker.events.push({
            type: 'task_complete',
            taskId: 'bg-1',
            result: 'API built successfully',
            completedAt: Date.now(),
        });

        await sleep(300);

        expect(handler.invoke).toHaveBeenCalledTimes(2);
        const secondCall = (handler.invoke as ReturnType<typeof vi.fn>).mock.calls[1];
        expect(secondCall[0]).toContain('Background task #bg-1');
    });

    it('should handle task_error events', async () => {
        worker.start();
        worker.dispatch(createMessage('hello'));
        await sleep(200);

        worker.events.push({
            type: 'task_error',
            taskId: 'bg-2',
            error: 'timeout',
            completedAt: Date.now(),
        });

        await sleep(300);

        const errorReplies = replies.filter((r) => r.text.includes('bg-2'));
        expect(errorReplies).toHaveLength(1);
    });

    it('should send error message when agent throws', async () => {
        handler = {
            invoke: vi.fn().mockRejectedValue(new Error('LLM down')),
        };

        worker = new ChannelWorker({
            channel,
            threadId: 'test',
            agentHandler: handler,
            onReply: async (text, peer) => {
                replies.push({ text, peer });
            },
            coalesceDelayMs: 0,
        });

        worker.start();
        worker.dispatch(createMessage('hello'));

        await sleep(300);

        expect(replies.some((r) => r.text.includes('Something went wrong'))).toBe(true);
    });

    it('should expose messageQueue and events', () => {
        expect(worker.messageQueue).toBeDefined();
        expect(worker.events).toBeDefined();
    });
});

describe('ChannelWorker - message coalescing', () => {
    it('should coalesce rapid messages', async () => {
        const channel = createMockChannel();
        const handler = createMockHandler();
        const replies: { text: string }[] = [];

        const worker = new ChannelWorker({
            channel,
            threadId: 'test',
            agentHandler: handler,
            onReply: async (text) => {
                replies.push({ text });
            },
            coalesceDelayMs: 100,
        });

        worker.start();

        worker.dispatch(createMessage('fix bug'));
        worker.dispatch(createMessage('update readme'));

        await sleep(400);

        expect(handler.invoke).toHaveBeenCalledTimes(1);
        const callText = (handler.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(callText).toContain('[1] fix bug');
        expect(callText).toContain('[2] update readme');

        await worker.stop();
    });
});

describe('ChannelWorker - mid-turn injection', () => {
    it('should route messages to pending when turn is active', async () => {
        const channel = createMockChannel();
        let pendingAtInvokeEnd: string[] = [];
        let invokeStarted = false;

        const slowHandler: AgentHandler = {
            invoke: vi
                .fn()
                .mockImplementation(
                    async (_text: string, _threadId: string, callbacks: AgentCallbacks) => {
                        invokeStarted = true;
                        await sleep(300);
                        pendingAtInvokeEnd = [...callbacks.pending];
                        return { reply: 'done', didSendViaTool: false };
                    },
                ),
        };

        const worker = new ChannelWorker({
            channel,
            threadId: 'test',
            agentHandler: slowHandler,
            onReply: async () => {},
            coalesceDelayMs: 0,
        });

        worker.start();
        worker.dispatch(createMessage('build API'));

        while (!invokeStarted) await sleep(10);
        worker.dispatch(createMessage('actually use Fastify'));

        await sleep(500);

        expect(pendingAtInvokeEnd).toContain('actually use Fastify');

        await worker.stop();
    });

    it('should drain pending to msgQueue after turn ends', async () => {
        const channel = createMockChannel();
        const invokeCalls: string[] = [];

        const slowHandler: AgentHandler = {
            invoke: vi.fn().mockImplementation(async (text: string) => {
                invokeCalls.push(text);
                if (invokeCalls.length === 1) await sleep(200);
                return { reply: 'ok', didSendViaTool: false };
            }),
        };

        const worker = new ChannelWorker({
            channel,
            threadId: 'test',
            agentHandler: slowHandler,
            onReply: async () => {},
            coalesceDelayMs: 0,
        });

        worker.start();
        worker.dispatch(createMessage('first'));

        await sleep(50);
        worker.dispatch(createMessage('second'));

        await sleep(500);

        expect(invokeCalls).toHaveLength(2);
        expect(invokeCalls[0]).toBe('first');
        expect(invokeCalls[1]).toBe('second');

        await worker.stop();
    });

    it('should pass same pending array reference to agent', async () => {
        const channel = createMockChannel();
        let pendingRef: string[] | null = null;

        const handler: AgentHandler = {
            invoke: vi.fn().mockImplementation(async (_text, _threadId, callbacks) => {
                pendingRef = callbacks.pending;
                return { reply: 'ok', didSendViaTool: false };
            }),
        };

        const worker = new ChannelWorker({
            channel,
            threadId: 'test',
            agentHandler: handler,
            onReply: async () => {},
            coalesceDelayMs: 0,
        });

        worker.start();
        worker.dispatch(createMessage('hello'));
        await sleep(200);

        expect(pendingRef).toBeDefined();
        expect(Array.isArray(pendingRef)).toBe(true);

        await worker.stop();
    });
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
