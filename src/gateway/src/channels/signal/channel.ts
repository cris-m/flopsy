import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface } from 'readline';
import type { Peer, OutboundMessage, ReactionOptions, Message } from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import type { SignalChannelConfig } from './types';

export class SignalChannel extends BaseChannel {
    readonly name = 'signal';
    readonly authType = 'qr' as const;

    private process: ChildProcess | null = null;
    private reader: Interface | null = null;
    private readonly channelConfig: SignalChannelConfig;

    constructor(config: SignalChannelConfig) {
        super(config);
        this.channelConfig = config;
    }

    async connect(): Promise<void> {
        if (this.process) return;
        this.setStatus('connecting');

        try {
            const cliPath = this.channelConfig.cliPath ?? 'signal-cli';

            this.process = spawn(cliPath, ['-a', this.channelConfig.account, 'jsonRpc'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { PATH: process.env.PATH, HOME: process.env.HOME },
            });

            this.reader = createInterface({ input: this.process.stdout! });

            this.reader.on('line', (line) => {
                this.handleJsonRpcLine(line).catch((err) => this.emitError(toError(err)));
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
            this.emitError(toError(err));
        }
    }

    async disconnect(): Promise<void> {
        this.clearReconnect();
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

        const isGroup = message.peer.type === 'group';
        const id = `rpc-${Date.now()}`;

        this.writeRpc(id, 'send', {
            ...(isGroup ? { groupId: message.peer.id } : { recipient: [message.peer.id] }),
            message: message.body ?? '',
            ...(message.media?.length && {
                attachments: message.media.filter((m) => m.url).map((m) => m.url!),
            }),
        });

        return id;
    }

    async sendTyping(peer: Peer): Promise<void> {
        if (!this.process?.stdin) return;
        this.writeRpc(`typing-${Date.now()}`, 'sendTyping',
            peer.type === 'group' ? { groupId: peer.id } : { recipient: [peer.id] },
        );
    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.process?.stdin) throw new Error('Signal not connected');
        this.writeRpc(`react-${Date.now()}`, 'sendReaction', {
            ...(options.peer.type === 'group' ? { groupId: options.peer.id } : { recipient: [options.peer.id] }),
            emoji: options.remove ? '' : options.emoji,
            targetAuthor: options.peer.id,
            targetTimestamp: parseInt(options.messageId, 10),
            remove: options.remove ?? false,
        });
    }

    private writeRpc(id: string, method: string, params: Record<string, unknown>): void {
        this.process!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
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
}
