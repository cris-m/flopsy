import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface } from 'readline';
import type { Peer, OutboundMessage, ReactionOptions, Message } from '@gateway/types';
import { BaseChannel } from '@gateway/core/base-channel';
import type { SignalChannelConfig } from './types';

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const MAX_RECONNECT_ATTEMPTS = 6;

export class SignalChannel extends BaseChannel {
    readonly name = 'signal';
    readonly authType = 'qr' as const;

    private process: ChildProcess | null = null;
    private reader: Interface | null = null;
    private readonly channelConfig: SignalChannelConfig;
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(config: SignalChannelConfig) {
        super(config);
        this.channelConfig = config;
    }

    async connect(): Promise<void> {
        if (this.process) return;
        this.setStatus('connecting');

        try {
            const cliPath = this.channelConfig.cliPath ?? 'signal-cli';
            const account = this.channelConfig.account;

            this.process = spawn(cliPath, [
                '-a', account,
                'jsonRpc',
            ], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
            });

            this.reader = createInterface({ input: this.process.stdout! });

            this.reader.on('line', (line) => {
                this.handleJsonRpcLine(line).catch((err) =>
                    this.emitError(err instanceof Error ? err : new Error(String(err))),
                );
            });

            this.process.stderr?.on('data', (data: Buffer) => {
                const text = data.toString().trim();
                if (text.includes('tsdevice:')) {
                    const qrMatch = text.match(/tsdevice:\/\/\S+/);
                    if (qrMatch) this.emit('onQR', qrMatch[0]);
                }
            });

            this.process.on('close', (code) => {
                this.process = null;
                this.reader = null;
                if (code !== 0) this.scheduleReconnect();
                else this.setStatus('disconnected');
            });

            this.process.on('error', (err) => {
                this.setStatus('error');
                this.emitError(err);
            });

            this.reconnectAttempts = 0;
            this.setStatus('connected');
            this.emit('onAuthUpdate', 'authenticated');
        } catch (err) {
            this.setStatus('error');
            this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
    }

    async disconnect(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;

        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }
        if (this.reader) {
            this.reader.close();
            this.reader = null;
        }
        this.setStatus('disconnected');
    }

    async send(message: OutboundMessage): Promise<string> {
        if (!this.process?.stdin) throw new Error('Signal not connected');

        const args: string[] = [];
        const isGroup = message.peer.type === 'group';

        if (isGroup) {
            args.push('-g', message.peer.id);
        } else {
            args.push(message.peer.id);
        }

        if (message.media?.length) {
            for (const media of message.media) {
                if (media.url) args.push('-a', media.url);
            }
        }

        const id = `rpc-${Date.now()}`;
        const rpc = {
            jsonrpc: '2.0',
            id,
            method: 'send',
            params: {
                ...(isGroup ? { groupId: message.peer.id } : { recipient: [message.peer.id] }),
                message: message.body ?? '',
                ...(message.media?.length && {
                    attachments: message.media
                        .filter((m) => m.url)
                        .map((m) => m.url!),
                }),
            },
        };

        this.process.stdin.write(JSON.stringify(rpc) + '\n');
        return id;
    }

    async sendTyping(peer: Peer): Promise<void> {
        if (!this.process?.stdin) return;

        const rpc = {
            jsonrpc: '2.0',
            id: `typing-${Date.now()}`,
            method: 'sendTyping',
            params: peer.type === 'group'
                ? { groupId: peer.id }
                : { recipient: [peer.id] },
        };

        this.process.stdin.write(JSON.stringify(rpc) + '\n');
    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.process?.stdin) throw new Error('Signal not connected');

        const rpc = {
            jsonrpc: '2.0',
            id: `react-${Date.now()}`,
            method: 'sendReaction',
            params: {
                ...(options.peer.type === 'group'
                    ? { groupId: options.peer.id }
                    : { recipient: [options.peer.id] }),
                emoji: options.remove ? '' : options.emoji,
                targetAuthor: options.peer.id,
                targetTimestamp: parseInt(options.messageId, 10),
                remove: options.remove ?? false,
            },
        };

        this.process.stdin.write(JSON.stringify(rpc) + '\n');
    }

    private async handleJsonRpcLine(line: string): Promise<void> {
        let parsed: { method?: string; params?: Record<string, unknown> };
        try {
            parsed = JSON.parse(line);
        } catch {
            return;
        }

        if (parsed.method !== 'receive') return;

        const envelope = parsed.params?.envelope as Record<string, unknown> | undefined;
        if (!envelope) return;

        const dataMessage = envelope.dataMessage as Record<string, unknown> | undefined;
        if (!dataMessage?.message) return;

        const source = String(envelope.source ?? '');
        const groupInfo = dataMessage.groupInfo as { groupId?: string } | undefined;
        const isGroup = !!groupInfo?.groupId;
        const peerId = isGroup ? String(groupInfo!.groupId) : source;
        const peerType = isGroup ? 'group' as const : 'user' as const;

        if (!this.isAllowed(isGroup ? peerId : source, peerType)) return;

        const normalized: Message = {
            id: String(dataMessage.timestamp ?? Date.now()),
            channelName: this.name,
            peer: { id: peerId, type: peerType },
            sender: { id: source, name: String(envelope.sourceName ?? '') },
            body: String(dataMessage.message),
            timestamp: new Date(Number(envelope.timestamp ?? Date.now())).toISOString(),
        };

        await this.emit('onMessage', normalized);
    }

    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            this.setStatus('error');
            this.emitError(new Error('Max reconnect attempts reached'));
            return;
        }

        const delay = RECONNECT_BACKOFF_MS[this.reconnectAttempts] ?? 60_000;
        this.reconnectAttempts++;
        this.setStatus('connecting');

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch((err) => this.emitError(err instanceof Error ? err : new Error(String(err))));
        }, delay);
    }
}
