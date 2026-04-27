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
    keyBelongsToChannel,
    type GroupScope,
} from './routing-key';

export interface MessageRouterConfig {
    readonly agentHandler: AgentHandler;
    readonly coalesceDelayMs?: number;
    /**
     * How to scope group/channel threads. 'per-chat' (default) means every
     * participant in a shared space writes into one conversation (speaker
     * identity is conveyed by an inline prefix, not by splitting sessions).
     * 'per-participant' gives each member their own isolated session within
     * a group.
     */
    readonly groupScope?: GroupScope;
    /**
     * Supplies the `/status` snapshot. When provided, the router augments
     * the closure with its own `activeThreads` count (= live workers) before
     * handing it to each ChannelWorker. Optional so tests and isolated
     * routers still work without a gateway wired behind them.
     */
    readonly gatewaySnapshotFn?: () => Omit<GatewayStatusSnapshot, 'activeThreads'>;
}

/**
 * MessageRouter — dispatches each inbound message to the worker for its
 * routing key. One worker per distinct conversation
 * (`{channel}:dm:{peerId}`, `{channel}:group:{peerId}`, etc.), lazily
 * created on first message. Workers are keyed by the routing key, NOT the
 * channel name — so two users DMing the same platform get separate workers
 * with separate checkpointed agent state.
 */
export class MessageRouter {
    private readonly log = createLogger('router');
    private readonly workers = new Map<string, ChannelWorker>();
    private readonly agentHandler: AgentHandler;
    private readonly coalesceDelayMs: number | undefined;
    private readonly groupScope: GroupScope;
    private readonly gatewaySnapshotFn: MessageRouterConfig['gatewaySnapshotFn'];

    constructor(config: MessageRouterConfig) {
        this.agentHandler = config.agentHandler;
        this.coalesceDelayMs = config.coalesceDelayMs;
        this.groupScope = config.groupScope ?? 'per-chat';
        this.gatewaySnapshotFn = config.gatewaySnapshotFn;
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
     * Look up a worker. Accepts either a routing key (preferred, exact match)
     * OR a channel name (returns the first worker for that channel —
     * non-deterministic, kept only for the legacy webhook-delivery path).
     */
    getWorker(keyOrChannel: string): ChannelWorker | undefined {
        const exact = this.workers.get(keyOrChannel);
        if (exact) return exact;
        for (const [key, worker] of this.workers) {
            if (keyBelongsToChannel(key, keyOrChannel)) return worker;
        }
        return undefined;
    }

    /**
     * Find every worker belonging to a channel. Used for broadcast /
     * shutdown-by-channel.
     */
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

    /**
     * Pre-registration is a no-op under per-routing-key worker maps —
     * workers are created lazily on first message. Kept for API compat;
     * emits a debug log so callers can see the channel is wired.
     */
    registerChannel(channel: Channel): void {
        this.log.debug({ channel: channel.name }, 'channel registered (workers lazy-created)');
    }

    /**
     * Stop every worker belonging to a channel. Used on connection drop or
     * runtime disable.
     */
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

    // -----------------------------------------------------------------------

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
                // Translate the caller's lightweight options shape into the
                // full OutboundMessage.interactive block so channels see a
                // uniform contract. Media flows through unchanged.
                const interactive =
                    options?.buttons && options.buttons.length > 0
                        ? {
                              blocks: [
                                  { type: 'buttons' as const, buttons: [...options.buttons] },
                              ],
                          }
                        : undefined;
                const media = options?.media ? [...options.media] : undefined;
                await channel.send({ peer, body: text, replyTo, interactive, media });
            },
            onSendPoll: async (peer, question, options, pollOptions): Promise<void> => {
                // Prefer native poll when the channel supports it. Otherwise
                // fall back to a text-rendered poll — numbered list that the
                // user can reply to with a digit. Keeps polls usable on
                // iMessage, WhatsApp, Signal without per-channel special cases.
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

// Helper for symmetry / external callers — re-exported so consumers don't
// need to cross-import routing-key directly.
export { buildRoutingKey, channelFromKey };
