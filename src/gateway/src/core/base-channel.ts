import type {
    Channel,
    ChannelStatus,
    ChannelEvents,
    AuthType,
    DmPolicy,
    GroupPolicy,
    Peer,
    OutboundMessage,
    ReactionOptions,
    AccessControlUpdate,
    PairingRequestHandler,
    BaseChannelConfig,
} from '@gateway/types';

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const MAX_RECONNECT_ATTEMPTS = 6;

export function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}

export abstract class BaseChannel implements Channel {
    abstract readonly name: string;
    abstract readonly authType: AuthType;

    pairingRequestHandler: PairingRequestHandler | null = null;

    protected reconnectAttempts = 0;
    protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    private _status: ChannelStatus = 'disconnected';
    private _config: BaseChannelConfig;
    private handlers: { [K in keyof ChannelEvents]?: ChannelEvents[K] } = {};

    constructor(config: BaseChannelConfig) {
        this._config = { ...config };
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
            if (!this.pairingRequestHandler) return false;
            const allowed = this._config.allowFrom ?? [];
            if (allowed.includes(senderId)) return true;
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
}
