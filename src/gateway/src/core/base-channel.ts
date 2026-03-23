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
} from '@gateway/types';

export interface BaseChannelConfig {
    enabled: boolean;
    dmPolicy: DmPolicy;
    groupPolicy?: GroupPolicy;
    allowFrom?: string[];
    blockedFrom?: string[];
    allowedGroups?: string[];
}

export abstract class BaseChannel implements Channel {
    abstract readonly name: string;
    abstract readonly authType: AuthType;

    pairingRequestHandler: PairingRequestHandler | null = null;

    private _status: ChannelStatus = 'disconnected';
    private _config: BaseChannelConfig;

    private handlers: {
        [K in keyof ChannelEvents]?: ChannelEvents[K];
    } = {};

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

    off<K extends keyof ChannelEvents>(event: K, _handler: ChannelEvents[K]): void {
        delete this.handlers[event];
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
            return this.pairingRequestHandler != null;
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
