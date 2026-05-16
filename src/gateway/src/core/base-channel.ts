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

    pairingRequestHandler: PairingRequestHandler | null = null;

    protected reconnectAttempts = 0;
    protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // Lazy getter — subclass `readonly name` initialisers run after
    // `super()`, so `this.name` is undefined inside the base constructor.
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
        // Inbound messages are sanitized centrally here so every channel
        // adapter gets the benefit without per-adapter wiring. `sanitizeInbound`
        // strips null bytes and clamps body/peer/sender lengths — defense
        // against an adversarial inbound (a Telegram user with a 1MB name,
        // a webhook with a NUL-injected id, etc.) reaching the router and
        // downstream agent. The function preserves the Message shape so
        // subclasses see identical types.
        if (event === 'onMessage' && args[0] && typeof args[0] === 'object') {
            // Two casts via `unknown` because the args tuple is typed as
            // the union `Error | Message | InteractionCallback`; we narrowed
            // to "object" but TS still wants explicit erasure.
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
                // Merge sanitized fields back into the original object so
                // any adapter-specific extras (media, raw provider payload,
                // platform-native ids) survive. We mutate args via the
                // generic `unknown[]` view so TS doesn't complain about
                // the variadic-args narrowing.
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
            // Allowed if either config-pinned (allowFrom) or runtime-approved
            // via the pairing facade.
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
}
