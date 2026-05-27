import { createLogger } from '@flopsy/shared';
import type {
    Channel,
    ChannelStatus,
    ChannelEvents,
    AuthType,
    DmPolicy,
    GroupPolicy,
    Peer,
    OutboundMessage,
    DeliverMessagesOptions,
    DeliverMessagesResult,
    ReactionOptions,
    AccessControlUpdate,
    PairingRequestHandler,
    BaseChannelConfig,
} from '@gateway/types';
import { getPairingFacade } from '@gateway/commands/pairing-facade';
import { sanitizeInbound } from './security';

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const MAX_RECONNECT_ATTEMPTS = 6;

export function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}

export abstract class BaseChannel implements Channel {
    abstract readonly name: string;
    abstract readonly authType: AuthType;

    /**
     * When true, the channel-worker's reasoning lane surfaces the agent's
     * thinking on this channel (single edit-in-place message, truncated to
     * fit). Default false — matches Hermes/openclaw industry pattern where
     * reasoning is observability data, not user content.
     *
     * Per-channel opt-in via `channels.<name>.showThinking: true` in
     * flopsy.json5. Channels read the config in their constructor and set
     * this flag.
     */
    showThinking = false;

    pairingRequestHandler: PairingRequestHandler | null = null;

    protected reconnectAttempts = 0;
    protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    private _log?: ReturnType<typeof createLogger>;
    protected get log(): ReturnType<typeof createLogger> {
        if (!this._log) this._log = createLogger(this.name || 'channel');
        return this._log;
    }

    private _status: ChannelStatus = 'disconnected';
    private _config: BaseChannelConfig;
    private handlers: { [K in keyof ChannelEvents]?: ChannelEvents[K] } = {};

    constructor(config: BaseChannelConfig) {
        this._config = { ...config };
        this.showThinking = config.showThinking === true;
    }

    get status(): ChannelStatus {
        return this._status;
    }

    get enabled(): boolean {
        return this._config.enabled;
    }

    get dmPolicy(): DmPolicy {
        return this._config.dmPolicy;
    }

    get groupPolicy(): GroupPolicy {
        return this._config.groupPolicy ?? 'disabled';
    }

    on<K extends keyof ChannelEvents>(event: K, handler: ChannelEvents[K]): void {
        this.handlers[event] = handler;
    }

    off<K extends keyof ChannelEvents>(event: K, handler: ChannelEvents[K]): void {
        if (this.handlers[event] === handler) {
            delete this.handlers[event];
        }
    }

    protected emit<K extends keyof ChannelEvents>(
        event: K,
        ...args: Parameters<ChannelEvents[K]>
    ): ReturnType<ChannelEvents[K]> | undefined {
        const handler = this.handlers[event];
        if (!handler) return undefined;
        if (event === 'onMessage' && args[0] && typeof args[0] === 'object') {
            const raw = args[0] as unknown as {
                id?: string;
                channelName?: string;
                body?: string;
                peer?: { id: string; type: 'user' | 'group' | 'channel'; name?: string };
                sender?: { id: string; name?: string };
                [k: string]: unknown;
            };
            if (typeof raw.id === 'string' && typeof raw.channelName === 'string' && typeof raw.body === 'string') {
                const sanitized = sanitizeInbound({
                    id: raw.id,
                    channelName: raw.channelName,
                    body: raw.body,
                    ...(raw.peer ? { peer: raw.peer } : {}),
                    ...(raw.sender ? { sender: raw.sender } : {}),
                });
                (args as unknown as unknown[])[0] = { ...raw, ...sanitized };
            }
        }
        return (handler as (...a: unknown[]) => ReturnType<ChannelEvents[K]>)(...args);
    }

    protected setStatus(status: ChannelStatus): void {
        if (this._status === status) return;
        this._status = status;
        this.emit('onStatusChange', status);
    }

    protected emitError(error: Error): void {
        this.emit('onError', error);
    }

    protected scheduleReconnect(): void {
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
            this.connect().catch((err) => this.emitError(toError(err)));
        }, delay);
    }

    protected clearReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;
    }

    isAllowed(senderId: string, peerType: 'user' | 'group' | 'channel'): boolean {
        const blocked = this._config.blockedFrom ?? [];
        if (blocked.includes(senderId)) return false;

        if (peerType === 'group') {
            if (this.groupPolicy === 'disabled') return false;
            if (this.groupPolicy === 'open') return true;
            const allowed = this._config.allowedGroups ?? [];
            return allowed.includes(senderId);
        }

        if (this.dmPolicy === 'disabled') return false;
        if (this.dmPolicy === 'open') return true;

        if (this.dmPolicy === 'allowlist') {
            const allowed = this._config.allowFrom ?? [];
            return allowed.includes(senderId);
        }

        if (this.dmPolicy === 'pairing') {
            const allowed = this._config.allowFrom ?? [];
            if (allowed.includes(senderId)) return true;
            const facade = getPairingFacade();
            if (facade && facade.isApproved(this.name, senderId)) return true;
            if (!this.pairingRequestHandler) return false;
            this.pairingRequestHandler({ channelName: this.name, senderId, timestamp: Date.now() });
            return false;
        }

        return false;
    }

    updateAccessControl(update: AccessControlUpdate): void {
        if (update.dmPolicy !== undefined) this._config.dmPolicy = update.dmPolicy;
        if (update.allowFrom !== undefined) this._config.allowFrom = update.allowFrom;
        if (update.blockedFrom !== undefined) this._config.blockedFrom = update.blockedFrom;
        if (update.groupPolicy !== undefined) this._config.groupPolicy = update.groupPolicy;
        if (update.allowedGroups !== undefined) this._config.allowedGroups = update.allowedGroups;
    }

    abstract connect(): Promise<void>;
    abstract disconnect(): Promise<void>;
    abstract send(message: OutboundMessage): Promise<string>;
    abstract sendTyping(peer: Peer): Promise<void>;
    abstract react(options: ReactionOptions): Promise<void>;

    /**
     * Default plain-text rendering for channels with no markdown/spoiler
     * support (line, signal, imessage, googlechat). Header line + `┊ `
     * vertical-bar prefix on each body line so the reasoning visually reads
     * as a sidebar rather than mixing with the answer. Channels with native
     * spoiler/collapsible support (telegram, discord) override this.
     */
    formatReasoning(content: string): string {
        const trimmed = content.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('💭')) return trimmed;
        const lines = trimmed.split('\n').map((l) => `┊ ${l}`).join('\n');
        return `💭 Reasoning:\n${lines}`;
    }

    /**
     * The single multi-message delivery primitive. Sends N parts as N channel
     * messages with natural pacing, typing indicator between, reply-chain only
     * on parts[0], and per-part error isolation (part 2 failing does not abort
     * part 3). Single-part input collapses to a normal `send`.
     *
     * Default pacing: ~30ms per char of the just-sent part, clamped [400, 1500]ms.
     * Long messages get longer pauses (mirrors human reading time before
     * reading the next message). Overridable via opts.pauseMs.
     *
     * Channels MAY override this method if they have a native batch API
     * (e.g. Discord's message-batch endpoint), but the default implementation
     * works for every channel because it composes from `send` + `sendTyping`.
     */
    async deliverMessages(opts: DeliverMessagesOptions): Promise<DeliverMessagesResult> {
        const { peer, parts, replyTo, showTyping = true, media } = opts;
        const cleaned = parts.map((p) => p.trim()).filter((p) => p.length > 0);
        if (cleaned.length === 0) {
            return { messageIds: [], allSent: true };
        }
        if (cleaned.length === 1) {
            try {
                const id = await this.send({
                    peer,
                    body: cleaned[0]!,
                    ...(replyTo ? { replyTo } : {}),
                    ...(media ? { media } : {}),
                });
                return { messageIds: [id], allSent: true };
            } catch {
                return { messageIds: [null], allSent: false };
            }
        }

        const messageIds: (string | null)[] = [];
        let allSent = true;
        const defaultPause = (_i: number, p: string): number =>
            Math.min(1500, Math.max(400, Math.round(p.length * 30)));
        const pauseFor = typeof opts.pauseMs === 'function'
            ? opts.pauseMs
            : typeof opts.pauseMs === 'number'
                ? () => opts.pauseMs as number
                : defaultPause;

        for (let i = 0; i < cleaned.length; i++) {
            const part = cleaned[i]!;
            const isFirst = i === 0;
            try {
                const id = await this.send({
                    peer,
                    body: part,
                    ...(isFirst && replyTo ? { replyTo } : {}),
                    ...(isFirst && media ? { media } : {}),
                });
                messageIds.push(id);
            } catch {
                messageIds.push(null);
                allSent = false;
            }
            if (i < cleaned.length - 1) {
                if (showTyping) {
                    try { await this.sendTyping(peer); } catch { /* non-fatal */ }
                }
                const ms = pauseFor(i, part);
                if (ms > 0) await new Promise((r) => setTimeout(r, ms));
            }
        }
        return { messageIds, allSent };
    }
}
