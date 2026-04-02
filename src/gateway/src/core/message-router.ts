import { createLogger } from '@flopsy/shared';

import type { Channel, Message, Peer, ChannelWorkerConfig } from '@gateway/types';

import type { AgentHandler } from '../types/agent';
import { ChannelWorker } from './channel-worker';

export interface MessageRouterConfig {
    readonly agentHandler: AgentHandler;
    readonly coalesceDelayMs?: number;
}

export class MessageRouter {
    private readonly log = createLogger('router');
    private readonly workers = new Map<string, ChannelWorker>();
    private readonly agentHandler: AgentHandler;
    private readonly coalesceDelayMs: number | undefined;

    constructor(config: MessageRouterConfig) {
        this.agentHandler = config.agentHandler;
        this.coalesceDelayMs = config.coalesceDelayMs;
    }

    route(message: Message, channel: Channel): void {
        const worker = this.getOrCreateWorker(channel);
        this.log.trace(
            { channel: channel.name, messageId: message.id },
            'routing message to worker',
        );
        worker.dispatch(message);
    }

    getWorker(channelName: string): ChannelWorker | undefined {
        return this.workers.get(channelName);
    }

    async stopAll(): Promise<void> {
        this.log.info({ workers: this.workers.size }, 'stopping all workers');
        const stops = [...this.workers.values()].map((w) => w.stop());
        await Promise.allSettled(stops);
        this.workers.clear();
        this.log.debug('all workers stopped');
    }

    registerChannel(channel: Channel): void {
        if (this.workers.has(channel.name)) return;
        this.createWorker(channel);
    }

    unregisterChannel(channelName: string): void {
        const worker = this.workers.get(channelName);
        if (!worker) return;
        this.log.info({ channel: channelName }, 'unregistering channel worker');
        worker.stop().catch(() => {});
        this.workers.delete(channelName);
    }

    private getOrCreateWorker(channel: Channel): ChannelWorker {
        const existing = this.workers.get(channel.name);
        if (existing) return existing;
        return this.createWorker(channel);
    }

    private createWorker(channel: Channel): ChannelWorker {
        const config: ChannelWorkerConfig = {
            channel,
            threadId: channel.name,
            agentHandler: this.agentHandler,
            onReply: async (text: string, peer: Peer, replyTo?: string): Promise<void> => {
                await channel.send({ peer, body: text, replyTo });
            },
            coalesceDelayMs: this.coalesceDelayMs,
        };

        const worker = new ChannelWorker(config);
        this.workers.set(channel.name, worker);
        worker.start();
        this.log.debug({ channel: channel.name }, 'worker created');
        return worker;
    }
}
