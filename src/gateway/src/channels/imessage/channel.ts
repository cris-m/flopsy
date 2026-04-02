import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Peer, OutboundMessage, ReactionOptions, Message } from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import type { IMessageChannelConfig } from './types';

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 3_000;
const EXEC_TIMEOUT_MS = 15_000;

export class IMessageChannel extends BaseChannel {
    readonly name = 'imessage';
    readonly authType = 'none';

    private readonly channelConfig: IMessageChannelConfig;
    private readonly cliPath: string;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private lastTimestamp: string = new Date().toISOString();

    constructor(config: IMessageChannelConfig) {
        super(config);
        this.channelConfig = config;
        this.cliPath = config.cliPath ?? 'imsg';
    }

    async connect(): Promise<void> {
        this.setStatus('connecting');

        try {
            await execFileAsync(this.cliPath, ['--version'], { timeout: EXEC_TIMEOUT_MS });

            this.lastTimestamp = new Date().toISOString();

            this.pollTimer = setInterval(() => {
                this.poll().catch((err) => this.emitError(toError(err)));
            }, POLL_INTERVAL_MS);
            this.pollTimer.unref();

            this.setStatus('connected');
            this.emit('onAuthUpdate', 'authenticated');
        } catch (err) {
            this.setStatus('error');
            this.emitError(toError(err));
        }
    }

    async disconnect(): Promise<void> {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.setStatus('disconnected');
    }

    async send(message: OutboundMessage): Promise<string> {
        const recipient = message.peer.id;

        if (message.media?.length) {
            for (const media of message.media) {
                if (!media.url) continue;
                await execFileAsync(
                    this.cliPath,
                    ['send', '--to', recipient, '--file', media.url],
                    { timeout: EXEC_TIMEOUT_MS },
                );
            }
        }

        if (message.body?.trim()) {
            await execFileAsync(this.cliPath, ['send', '--to', recipient, '--text', message.body], {
                timeout: EXEC_TIMEOUT_MS,
            });
        }

        return `imsg-${Date.now()}`;
    }

    async sendTyping(_peer: Peer): Promise<void> {}

    async react(_options: ReactionOptions): Promise<void> {}

    private async poll(): Promise<void> {
        let stdout: string;
        try {
            const result = await execFileAsync(
                this.cliPath,
                ['watch', '--after', this.lastTimestamp, '--json'],
                { timeout: EXEC_TIMEOUT_MS },
            );
            stdout = result.stdout;
        } catch {
            return;
        }

        if (!stdout.trim()) return;

        let messages: Array<{
            id?: string;
            sender?: string;
            text?: string;
            date?: string;
            is_from_me?: boolean;
            chat_id?: string;
            attachments?: Array<{ path?: string; mime_type?: string }>;
        }>;
        try {
            messages = JSON.parse(stdout);
        } catch {
            return;
        }

        for (const msg of messages) {
            if (!msg.text && !msg.attachments?.length) continue;
            if (msg.is_from_me && !this.channelConfig.selfChatMode) continue;

            const senderId = msg.sender ?? '';
            if (!this.isAllowed(senderId, 'user')) continue;

            const media = msg.attachments?.map((a) => ({
                type: 'document' as const,
                url: a.path,
                mimeType: a.mime_type,
            }));

            const normalized: Message = {
                id: msg.id ?? `imsg-${Date.now()}`,
                channelName: this.name,
                peer: { id: msg.chat_id ?? senderId, type: 'user' },
                sender: { id: senderId },
                body: msg.text ?? '',
                timestamp: msg.date ?? new Date().toISOString(),
                ...(media?.length && { media }),
            };

            this.lastTimestamp = normalized.timestamp;
            await this.emit('onMessage', normalized);
        }
    }
}
