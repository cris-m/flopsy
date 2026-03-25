import { createLogger } from '@flopsy/shared';

import type { Channel, Message, Peer } from '@gateway/types';

import type { AgentCallbacks, AgentHandler, InvokeRole } from './agent-handler';
import { EventQueue, type ChannelEvent } from './event-queue';
import { MessageQueue, coalesce } from './message-queue';

const ABORT_PHRASES = new Set(['stop', 'cancel', 'forget it', 'nevermind', 'abort']);
const MAX_PENDING = 100;
const AGENT_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 5_000;

export interface ChannelWorkerConfig {
    readonly channel: Channel;
    readonly threadId: string;
    readonly agentHandler: AgentHandler;
    readonly onReply: (text: string, peer: Peer, replyTo?: string) => Promise<void>;
    readonly coalesceDelayMs?: number;
}

export class ChannelWorker {
    private readonly log = createLogger('worker');
    private readonly channel: Channel;
    private readonly threadId: string;
    private readonly agentHandler: AgentHandler;
    private readonly sendReply: (text: string, peer: Peer, replyTo?: string) => Promise<void>;
    private readonly msgQueue: MessageQueue;
    private readonly eventQueue: EventQueue;
    private readonly pending: string[] = [];

    private running = false;
    private turnActive = false;
    private currentAbort: AbortController | null = null;
    private currentPeer: Peer | null = null;
    private lastMessageId: string | null = null;
    private loopPromise: Promise<void> | null = null;
    private waitCleanup: (() => void) | null = null;

    constructor(config: ChannelWorkerConfig) {
        this.channel = config.channel;
        this.threadId = config.threadId;
        this.agentHandler = config.agentHandler;
        this.sendReply = config.onReply;
        this.msgQueue = new MessageQueue(config.coalesceDelayMs);
        this.eventQueue = new EventQueue();
    }

    get messageQueue(): MessageQueue {
        return this.msgQueue;
    }

    get events(): EventQueue {
        return this.eventQueue;
    }

    get isRunning(): boolean {
        return this.running;
    }

    dispatch(message: Message): void {
        const text = message.body;

        if (isAbortRequest(text)) {
            if (this.currentAbort) {
                this.currentAbort.abort();
                this.sendReply('Stopped.', message.peer).catch(() => {});
            }
            return;
        }

        this.currentPeer = message.peer;
        this.lastMessageId = message.id;

        if (this.turnActive) {
            if (this.pending.length < MAX_PENDING) {
                this.pending.push(text);
            }
        } else {
            this.msgQueue.enqueue(text);
        }
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.loopPromise = this.loop();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.currentAbort?.abort();
        this.msgQueue.clear();
        this.eventQueue.clear();
        this.pending.length = 0;
        this.cancelWait();
        if (this.loopPromise) {
            await Promise.race([this.loopPromise, sleep(STOP_TIMEOUT_MS)]);
            this.loopPromise = null;
        }
    }

    private async loop(): Promise<void> {
        this.log.info({ channel: this.channel.name, threadId: this.threadId }, 'worker started');

        while (this.running) {
            try {
                const event = this.eventQueue.tryDequeue();
                if (event) {
                    await this.handleEvent(event);
                    continue;
                }

                const [waitPromise, cleanup] = this.createWaitForEventOrStop();
                this.waitCleanup = cleanup;

                const batch = await Promise.race([
                    this.msgQueue.dequeue(),
                    waitPromise,
                ]);

                this.cancelWait();

                if (!batch || batch.length === 0) continue;

                const text = coalesce(batch);
                await this.runAgentTurn(text, 'user');
            } catch (err) {
                if (!this.running) break;
                this.log.error({ err, channel: this.channel.name }, 'worker loop error');
                await sleep(1_000);
            }
        }

        this.log.info({ channel: this.channel.name }, 'worker stopped');
    }

    private async runAgentTurn(text: string, role: InvokeRole): Promise<void> {
        const abort = new AbortController();
        this.currentAbort = abort;
        this.turnActive = true;

        let didSendViaTool = false;
        const peer = this.currentPeer;
        const replyTo = this.lastMessageId ?? undefined;

        if (!peer) {
            this.log.error({ channel: this.channel.name }, 'no peer for agent turn');
            this.turnActive = false;
            return;
        }

        const callbacks: AgentCallbacks = {
            onReply: async (reply: string): Promise<void> => {
                await this.sendReply(reply, peer, replyTo);
            },
            setDidSendViaTool: (): void => {
                didSendViaTool = true;
            },
            eventQueue: this.eventQueue,
            pending: this.pending,
            signal: abort.signal,
        };

        try {
            await this.sendTyping(peer);

            const result = await Promise.race([
                this.agentHandler.invoke(text, this.threadId, callbacks, role),
                rejectAfterTimeout(AGENT_TIMEOUT_MS, abort.signal),
            ]);

            if (!didSendViaTool && !result.didSendViaTool && result.reply) {
                await this.sendReply(result.reply, peer, replyTo);
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                if (!didSendViaTool) {
                    await this.sendReply('Stopped. What would you like instead?', peer).catch(() => {});
                }
            } else {
                this.log.error({ err, channel: this.channel.name }, 'agent turn failed');
                await this.sendReply('Something went wrong. Please try again.', peer).catch(() => {});
            }
        } finally {
            this.currentAbort = null;
            this.turnActive = false;
            this.drainPendingToQueue();
        }
    }

    private drainPendingToQueue(): void {
        while (this.pending.length > 0) {
            const text = this.pending.shift()!;
            this.msgQueue.enqueue(text);
        }
    }

    private async handleEvent(event: ChannelEvent): Promise<void> {
        const peer = this.currentPeer;
        if (!peer) return;

        if (event.type === 'task_error') {
            this.log.error({ taskId: event.taskId, error: event.error }, 'background task failed');
            await this.sendReply(
                `Background task #${event.taskId} failed. Please try again.`,
                peer,
            ).catch(() => {});
            return;
        }

        const systemMessage = [
            `Background task #${event.taskId} has completed.`,
            `Result:`,
            event.result ?? '(no result)',
            '',
            'Relay this to the user naturally. Use send_message to deliver it.',
        ].join('\n');

        await this.runAgentTurn(systemMessage, 'system');
    }

    private async sendTyping(peer: Peer): Promise<void> {
        try {
            await this.channel.sendTyping(peer);
        } catch {}
    }

    private createWaitForEventOrStop(): [Promise<null>, () => void] {
        let handle: ReturnType<typeof setInterval>;
        const promise = new Promise<null>((resolve) => {
            handle = setInterval(() => {
                if (!this.running || this.eventQueue.size > 0) {
                    clearInterval(handle);
                    resolve(null);
                }
            }, 50);
        });
        const cleanup = (): void => { clearInterval(handle!); };
        return [promise, cleanup];
    }

    private cancelWait(): void {
        if (this.waitCleanup) {
            this.waitCleanup();
            this.waitCleanup = null;
        }
    }
}

function isAbortRequest(text: string): boolean {
    return ABORT_PHRASES.has(text.trim().toLowerCase());
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function rejectAfterTimeout(ms: number, signal: AbortSignal): Promise<never> {
    return new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Agent invocation timed out')), ms);
        signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    });
}
