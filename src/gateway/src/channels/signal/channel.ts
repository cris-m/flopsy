import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface } from 'readline';
import type { Peer, OutboundMessage, ReactionOptions, Message, Media } from '@gateway/types';
import { isTextDocument } from '@gateway/types';
import { BaseChannel, toError } from '@gateway/core/base-channel';
import { resolveMediaSource } from '@gateway/core/media-resolver';
import type { SignalChannelConfig } from './types';

const MAX_TEXT_DOCUMENT_BYTES = 256 * 1024;

interface SignalAttachment {
    id?: string;
    contentType?: string;
    filename?: string;
    size?: number;
}

/** Per-RPC ack timeout — signal-cli typically responds in <500ms but
 *  we cap at 10s so a hung child doesn't pin send() promises forever.
 *  Send still "returns success" on timeout (the RPC may have landed
 *  with no response surfaced); the alternative is rejecting and the
 *  caller retrying a probably-duplicate message. */
const RPC_ACK_TIMEOUT_MS = 10_000;

interface PendingRpc {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class SignalChannel extends BaseChannel {
    readonly name = 'signal';
    readonly authType = 'qr';
    readonly rendersCodeBlocks = false;

    private process: ChildProcess | null = null;
    private reader: Interface | null = null;
    private readonly channelConfig: SignalChannelConfig;
    /** id → pending RPC ack handlers. Previously send() resolved
     *  immediately after the stdin.write returned — the caller thought
     *  the message was delivered when signal-cli hadn't even tried yet.
     *  Now we correlate the JSON-RPC response by id and wait for it. */
    private readonly pendingRpcs = new Map<string, PendingRpc>();

    constructor(config: SignalChannelConfig) {
        super(config);
        this.channelConfig = config;
    }

    async connect(): Promise<void> {
        if (this.process) return;
        this.setStatus('connecting');

        try {
            const cliPath = this.channelConfig.cliPath ?? 'signal-cli';

            const cliArgs: string[] = [];
            if (this.channelConfig.sessionPath) {
                cliArgs.push('--config', this.channelConfig.sessionPath);
            }
            cliArgs.push('-a', this.channelConfig.account, 'jsonRpc');

            this.process = spawn(cliPath, cliArgs, {
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

        // Resolve media via the shared resolver. signal-cli's
        // `attachments` array accepts local file paths; remote http(s)
        // URLs aren't supported (we'd need to download first). Inline
        // base64 also unsupported by signal-cli — drop it with a
        // structured warning instead of silently mismatching.
        const attachments: string[] = [];
        if (message.media?.length) {
            for (const media of message.media) {
                const resolved = await resolveMediaSource(media);
                if (!resolved.ok) {
                    this.log.warn(
                        { peer: message.peer.id, mediaType: media.type, mediaUrl: media.url, reason: resolved.reason, detail: resolved.detail, op: 'send:media:rejected' },
                        'signal send: media resolution failed — skipping attachment',
                    );
                    continue;
                }
                if (resolved.source.kind !== 'local-path') {
                    this.log.warn(
                        { peer: message.peer.id, mediaType: media.type, sourceKind: resolved.source.kind, reason: 'signal-requires-local-path', op: 'send:media:rejected' },
                        'signal send: signal-cli only accepts local file paths for attachments — skipping',
                    );
                    continue;
                }
                attachments.push(resolved.source.absPath);
            }
        }

        await this.writeRpcAwait(id, 'send', {
            ...(isGroup ? { groupId: message.peer.id } : { recipient: [message.peer.id] }),
            message: message.body ?? '',
            ...(attachments.length && { attachments }),
        });

        return id;
    }

    /** Write an RPC and wait for the matching response (by id) before
     *  resolving. Timeout-bounded; logs on timeout but doesn't throw so
     *  the caller's send() promise still settles (the message may have
     *  landed even if the ack got lost). EPIPE on stdin.write is caught
     *  + rejected so the caller learns the channel is dead. */
    private async writeRpcAwait(id: string, method: string, params: Record<string, unknown>): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pendingRpcs.delete(id)) {
                    this.log.warn({ id, method }, 'signal RPC ack timeout — resolving anyway');
                    resolve(undefined);
                }
            }, RPC_ACK_TIMEOUT_MS);
            timer.unref?.();
            this.pendingRpcs.set(id, { resolve, reject, timer });
            try {
                if (!this.process?.stdin) {
                    throw new Error('Signal stdin not available');
                }
                this.process.stdin.write(
                    JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
                    (err) => {
                        if (err) {
                            clearTimeout(timer);
                            if (this.pendingRpcs.delete(id)) reject(err);
                        }
                    },
                );
            } catch (err) {
                clearTimeout(timer);
                if (this.pendingRpcs.delete(id)) reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    async sendTyping(peer: Peer): Promise<void> {
        if (!this.process?.stdin) return;
        this.writeRpc(
            `typing-${Date.now()}`,
            'sendTyping',
            peer.type === 'group' ? { groupId: peer.id } : { recipient: [peer.id] },
        );
    }

    async react(options: ReactionOptions): Promise<void> {
        if (!this.process?.stdin) throw new Error('Signal not connected');
        this.writeRpc(`react-${Date.now()}`, 'sendReaction', {
            ...(options.peer.type === 'group'
                ? { groupId: options.peer.id }
                : { recipient: [options.peer.id] }),
            emoji: options.remove ? '' : options.emoji,
            targetAuthor: options.peer.id,
            targetTimestamp: parseInt(options.messageId, 10),
            remove: options.remove ?? false,
        });
    }

    private writeRpc(id: string, method: string, params: Record<string, unknown>): void {
        // Non-awaiting fire-and-forget path — used by typing + react
        // where the caller doesn't need an ack. Still catches EPIPE
        // synchronously to avoid uncaught exceptions on dead stdin.
        try {
            this.process!.stdin!.write(
                JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
            );
        } catch (err) {
            this.log.debug({ id, method, err: err instanceof Error ? err.message : String(err) }, 'signal writeRpc failed (non-fatal)');
        }
    }

    private async handleJsonRpcLine(line: string): Promise<void> {
        let parsed: { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
        try {
            parsed = JSON.parse(line);
        } catch {
            return;
        }

        // RPC response correlation — match by id, resolve/reject the
        // pending promise from writeRpcAwait. Done BEFORE the receive
        // dispatch so a response line doesn't accidentally fall through
        // to message parsing.
        if (parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined)) {
            const rawId = String(parsed.id);
            // RPC ids we generate match `rpc-<digits>` (see writeRpcAwait
            // above). Reject any other shape so a malformed subprocess line
            // can't resolve an unrelated pending promise.
            if (!/^rpc-\d+$/.test(rawId)) return;
            const pending = this.pendingRpcs.get(rawId);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingRpcs.delete(rawId);
                if (parsed.error) {
                    const errMsg = typeof parsed.error === 'object' && parsed.error !== null && 'message' in parsed.error
                        ? String((parsed.error as { message: unknown }).message)
                        : JSON.stringify(parsed.error);
                    pending.reject(new Error(`signal RPC error: ${errMsg}`));
                } else {
                    pending.resolve(parsed.result);
                }
                return;
            }
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
        const peerType = isGroup ? ('group' as const) : ('user' as const);

        if (!this.isAllowed(isGroup ? peerId : source, peerType)) return;

        const media: Media[] = [];
        const attachments = dataMessage.attachments as SignalAttachment[] | undefined;
        if (Array.isArray(attachments) && attachments.length > 0) {
            for (const a of attachments) {
                const fileName = a.filename;
                const mimeType = a.contentType;
                const fileSize = a.size;
                if (mimeType?.startsWith('image/')) {
                    media.push({ type: 'image', mimeType, fileName, fileSize });
                } else if (mimeType?.startsWith('video/')) {
                    media.push({ type: 'video', mimeType, fileName, fileSize });
                } else if (isTextDocument(mimeType, fileName)) {
                    const attachDir = this.channelConfig.attachmentsPath;
                    const id = a.id;
                    const withinSize = !fileSize || fileSize <= MAX_TEXT_DOCUMENT_BYTES;
                    if (attachDir && id && withinSize) {
                        try {
                            const { readFile } = await import('fs/promises');
                            const { join } = await import('path');
                            const buffer = await readFile(join(attachDir, id));
                            if (buffer.length <= MAX_TEXT_DOCUMENT_BYTES) {
                                const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
                                media.push({ type: 'document', mimeType, fileName, fileSize, text });
                                continue;
                            }
                        } catch {
                            /* fall through */
                        }
                    }
                    media.push({ type: 'document', mimeType, fileName, fileSize });
                } else {
                    media.push({ type: 'document', mimeType, fileName, fileSize });
                }
            }
        }

        const normalized: Message = {
            id: String(dataMessage.timestamp ?? Date.now()),
            channelName: this.name,
            peer: { id: peerId, type: peerType },
            sender: { id: source, name: String(envelope.sourceName ?? '') },
            body: String(dataMessage.message),
            timestamp: new Date(Number(envelope.timestamp ?? Date.now())).toISOString(),
            ...(media.length > 0 && { media }),
        };

        await this.emit('onMessage', normalized);
    }
}
