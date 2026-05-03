import { createLogger } from '@flopsy/shared';

import type {
    Channel,
    Message,
    ChannelWorkerConfig,
    GatewayStatusSnapshot,
} from '@gateway/types';

import type { AgentHandler } from '../types/agent';
import { ChannelWorker } from './channel-worker';
import {
    buildRoutingKey,
    channelFromKey,
    peerFromKey,
    keyBelongsToChannel,
    type GroupScope,
} from './routing-key';
import { stripToolCallNoise } from './tool-call-sanitizer';

export interface MessageRouterConfig {
    readonly agentHandler: AgentHandler;
    readonly coalesceDelayMs?: number;
    /**
     * How to scope group/channel threads. 'per-chat' (default) means every
     * participant in a shared space writes into one conversation;
     * 'per-participant' gives each member their own isolated session.
     */
    readonly groupScope?: GroupScope;
    readonly gatewaySnapshotFn?: () => Omit<GatewayStatusSnapshot, 'activeThreads'>;
    readonly structuredOutputModel?: unknown;
}

/**
 * Dispatches each inbound message to the worker for its routing key. One
 * worker per distinct conversation, lazily created on first message.
 * Workers are keyed by routing key (not channel name), so two users DMing
 * the same platform get separate workers with separate checkpointed state.
 */
export class MessageRouter {
    private readonly log = createLogger('router');
    private readonly workers = new Map<string, ChannelWorker>();
    private readonly channels = new Map<string, Channel>();
    private readonly agentHandler: AgentHandler;
    private readonly coalesceDelayMs: number | undefined;
    private readonly groupScope: GroupScope;
    private readonly gatewaySnapshotFn: MessageRouterConfig['gatewaySnapshotFn'];
    private structuredOutputModel: unknown;

    constructor(config: MessageRouterConfig) {
        this.agentHandler = config.agentHandler;
        this.coalesceDelayMs = config.coalesceDelayMs;
        this.groupScope = config.groupScope ?? 'per-chat';
        this.gatewaySnapshotFn = config.gatewaySnapshotFn;
        this.structuredOutputModel = config.structuredOutputModel;
    }

    /** Propagates to existing workers so live threads update without a restart. */
    setStructuredOutputModel(model: unknown): void {
        this.structuredOutputModel = model;
        for (const worker of this.workers.values()) {
            worker.setStructuredOutputModel(model);
        }
    }

    route(message: Message, channel: Channel): void {
        const routingKey = buildRoutingKey(
            {
                channelName: channel.name,
                peer: message.peer,
                senderId: message.sender?.id,
            },
            { groupScope: this.groupScope },
        );
        const worker = this.getOrCreateWorker(channel, routingKey);
        this.log.trace(
            { channel: channel.name, routingKey, messageId: message.id },
            'routing message to worker',
        );
        worker.dispatch(message);
    }

    /**
     * Three resolution layers:
     *   1. Exact routing-key match.
     *   2. Channel-name fallback — most-recently-active worker, used by
     *      inbound webhooks lacking a peer identifier.
     *   3. undefined — caller logs and drops.
     */
    getWorker(keyOrChannel: string): ChannelWorker | undefined {
        const exact = this.workers.get(keyOrChannel);
        if (exact) return exact;

        let best: ChannelWorker | undefined;
        let bestActive = -Infinity;
        for (const [key, worker] of this.workers) {
            if (!keyBelongsToChannel(key, keyOrChannel)) continue;
            const active = worker.lastActiveAt;
            if (active > bestActive) {
                best = worker;
                bestActive = active;
            }
        }
        return best;
    }

    getWorkersForChannel(channelName: string): ChannelWorker[] {
        const out: ChannelWorker[] = [];
        for (const [key, worker] of this.workers) {
            if (keyBelongsToChannel(key, channelName)) out.push(worker);
        }
        return out;
    }

    async stopAll(): Promise<void> {
        this.log.info({ workers: this.workers.size }, 'stopping all workers');
        const stops = [...this.workers.values()].map((w) => w.stop());
        await Promise.allSettled(stops);
        this.workers.clear();
        this.log.debug('all workers stopped');
    }

    /** Workers are lazy; this only seeds the channel registry. */
    registerChannel(channel: Channel): void {
        this.channels.set(channel.name, channel);
        this.log.debug({ channel: channel.name }, 'channel registered (workers lazy-created)');
    }

    /**
     * Auto-create a worker for an exact routing key. Used by the inbound-
     * webhook delivery path with `targetThread` so cold-start delivery
     * doesn't depend on a prior user message. Returns undefined when the
     * key's channel isn't registered.
     */
    getOrCreateWorkerForKey(routingKey: string): ChannelWorker | undefined {
        const existing = this.workers.get(routingKey);
        if (existing) return existing;

        const channelName = channelFromKey(routingKey);
        if (!channelName) {
            this.log.warn({ routingKey }, 'getOrCreateWorkerForKey: malformed key — skipping');
            return undefined;
        }
        const channel = this.channels.get(channelName);
        if (!channel) {
            this.log.warn(
                { routingKey, channel: channelName },
                'getOrCreateWorkerForKey: channel not registered — skipping',
            );
            return undefined;
        }
        const worker = this.createWorker(channel, routingKey);
        // Seed currentPeer from the routing key so handleEvent's no-peer
        // guard doesn't drop webhook events when no user has messaged yet.
        const peer = peerFromKey(routingKey);
        if (peer) {
            worker.setDefaultPeer(peer);
            this.log.info(
                { routingKey, peerId: peer.id, peerType: peer.type },
                'getOrCreateWorkerForKey: worker created + peer seeded',
            );
        } else {
            this.log.warn(
                { routingKey },
                'getOrCreateWorkerForKey: could not derive peer from key; webhook events will drop until a user messages this thread',
            );
        }
        return worker;
    }

    unregisterChannel(channelName: string): void {
        const victims: string[] = [];
        for (const key of this.workers.keys()) {
            if (keyBelongsToChannel(key, channelName)) victims.push(key);
        }
        if (victims.length === 0) return;
        this.log.info(
            { channel: channelName, workers: victims.length },
            'unregistering channel workers',
        );
        for (const key of victims) {
            const w = this.workers.get(key);
            w?.stop().catch((err: unknown) => {
                this.log.warn(
                    { err, channel: channelName, threadId: key, op: 'worker.stop' },
                    'worker stop failed during channel unregister — possible resource leak',
                );
            });
            this.workers.delete(key);
        }
    }

    private getOrCreateWorker(channel: Channel, routingKey: string): ChannelWorker {
        const existing = this.workers.get(routingKey);
        if (existing) return existing;
        return this.createWorker(channel, routingKey);
    }

    private createWorker(channel: Channel, routingKey: string): ChannelWorker {
        const config: ChannelWorkerConfig = {
            channel,
            threadId: routingKey,
            agentHandler: this.agentHandler,
            onReply: async (text, peer, replyTo, options): Promise<void> => {
                const interactive =
                    options?.buttons && options.buttons.length > 0
                        ? {
                              blocks: [
                                  { type: 'buttons' as const, buttons: [...options.buttons] },
                              ],
                          }
                        : undefined;
                const media = options?.media ? [...options.media] : undefined;
                // Models occasionally emit raw tool-call format as prose
                // (tool not in active toolset, or "show your work" prompts).
                const cleaned = stripToolCallNoise(text);
                try {
                    await channel.send({ peer, body: cleaned, replyTo, interactive, media });
                } catch (err) {
                    // Surface at the router so a dropped delivery is visible
                    // even when the agent reports didSendViaTool=true.
                    this.log.error(
                        {
                            channel: channel.name,
                            peerId: peer.id,
                            peerType: peer.type,
                            bodyLen: cleaned.length,
                            err: err instanceof Error ? err.message : String(err),
                        },
                        'channel.send failed in onReply — message NOT delivered to user',
                    );
                    throw err;
                }
            },
            onSendPoll: async (peer, question, options, pollOptions): Promise<void> => {
                // Fall back to a numbered-list rendering for channels lacking
                // native polls (iMessage, WhatsApp, Signal).
                if (typeof channel.sendPoll === 'function') {
                    await channel.sendPoll({
                        peer,
                        question,
                        options,
                        ...(pollOptions?.anonymous !== undefined && {
                            anonymous: pollOptions.anonymous,
                        }),
                        ...(pollOptions?.allowMultiple !== undefined && {
                            allowMultiple: pollOptions.allowMultiple,
                        }),
                        ...(pollOptions?.durationHours !== undefined && {
                            durationHours: pollOptions.durationHours,
                        }),
                    });
                    return;
                }
                const numbered = options
                    .map((opt, i) => `${i + 1}. ${opt}`)
                    .join('\n');
                const body = `📊 ${question}\n\n${numbered}\n\n_Reply with the number._`;
                await channel.send({ peer, body });
            },
            coalesceDelayMs: this.coalesceDelayMs,
            getGatewayStatus: this.gatewaySnapshotFn
                ? () => {
                    const base = this.gatewaySnapshotFn!();
                    return { ...base, activeThreads: this.workers.size };
                }
                : undefined,
            ...(this.structuredOutputModel ? { structuredOutputModel: this.structuredOutputModel } : {}),
        };

        const worker = new ChannelWorker(config);
        this.workers.set(routingKey, worker);
        worker.start();
        this.log.debug(
            { channel: channel.name, routingKey },
            'worker created',
        );
        return worker;
    }
}

export { buildRoutingKey, channelFromKey, peerFromKey };
