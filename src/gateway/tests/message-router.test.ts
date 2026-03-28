import { describe, it, expect, vi, afterEach } from 'vitest';
import { MessageRouter } from '../src/core/message-router';
import type { AgentHandler, AgentResult } from '../src/types/agent';
import type { Channel, Message } from '../src/types';

function createMockChannel(name = 'discord'): Channel {
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

function createMockHandler(): AgentHandler {
    return {
        invoke: vi.fn().mockResolvedValue({
            reply: 'response',
            didSendViaTool: false,
        } satisfies AgentResult),
    };
}

function createMessage(channelName: string): Message {
    return {
        id: `msg-${Date.now()}`,
        channelName,
        peer: { id: 'user-1', type: 'user' },
        sender: { id: 'user-1', name: 'User' },
        body: 'test message',
        timestamp: new Date().toISOString(),
    };
}

describe('MessageRouter', () => {
    let router: MessageRouter;

    afterEach(async () => {
        if (router) await router.stopAll();
    });

    it('should create a worker on first route', async () => {
        const handler = createMockHandler();
        router = new MessageRouter({ agentHandler: handler, coalesceDelayMs: 0 });

        const channel = createMockChannel('discord');
        await router.route(createMessage('discord'), channel);

        const worker = router.getWorker('discord');
        expect(worker).toBeDefined();
        expect(worker!.isRunning).toBe(true);
    });

    it('should reuse existing worker for same channel', async () => {
        const handler = createMockHandler();
        router = new MessageRouter({ agentHandler: handler, coalesceDelayMs: 0 });

        const channel = createMockChannel('telegram');
        await router.route(createMessage('telegram'), channel);
        await sleep(200);
        await router.route(createMessage('telegram'), channel);
        await sleep(200);

        expect(handler.invoke).toHaveBeenCalledTimes(2);
    });

    it('should create separate workers per channel', async () => {
        const handler = createMockHandler();
        router = new MessageRouter({ agentHandler: handler, coalesceDelayMs: 0 });

        const discord = createMockChannel('discord');
        const telegram = createMockChannel('telegram');

        await router.route(createMessage('discord'), discord);
        await router.route(createMessage('telegram'), telegram);

        expect(router.getWorker('discord')).toBeDefined();
        expect(router.getWorker('telegram')).toBeDefined();
    });

    it('should register and start workers for channels', () => {
        const handler = createMockHandler();
        router = new MessageRouter({ agentHandler: handler });

        const channel = createMockChannel('whatsapp');
        router.registerChannel(channel);

        expect(router.getWorker('whatsapp')).toBeDefined();
    });

    it('should unregister channel worker', async () => {
        const handler = createMockHandler();
        router = new MessageRouter({ agentHandler: handler });

        const channel = createMockChannel('signal');
        router.registerChannel(channel);
        expect(router.getWorker('signal')).toBeDefined();

        router.unregisterChannel('signal');
        expect(router.getWorker('signal')).toBeUndefined();
    });

    it('should stop all workers', async () => {
        const handler = createMockHandler();
        router = new MessageRouter({ agentHandler: handler });

        router.registerChannel(createMockChannel('discord'));
        router.registerChannel(createMockChannel('telegram'));

        await router.stopAll();

        expect(router.getWorker('discord')).toBeUndefined();
        expect(router.getWorker('telegram')).toBeUndefined();
    });

    it('should not duplicate workers on registerChannel', () => {
        const handler = createMockHandler();
        router = new MessageRouter({ agentHandler: handler });

        const channel = createMockChannel('line');
        router.registerChannel(channel);
        router.registerChannel(channel);

        expect(router.getWorker('line')).toBeDefined();
    });

    it('should send reply back through channel.send', async () => {
        const handler = createMockHandler();
        router = new MessageRouter({ agentHandler: handler, coalesceDelayMs: 0 });

        const channel = createMockChannel('discord');
        await router.route(createMessage('discord'), channel);

        await sleep(300);

        expect(channel.send).toHaveBeenCalledWith(
            expect.objectContaining({
                peer: { id: 'user-1', type: 'user' },
                body: 'response',
            }),
        );
    });
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
