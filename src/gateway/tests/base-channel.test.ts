import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseChannel, toError } from '../src/core/base-channel';
import type {
    AuthType,
    OutboundMessage,
    Peer,
    ReactionOptions,
    BaseChannelConfig,
} from '../src/types';

// ---------------------------------------------------------------------------
// Concrete stub extending the abstract BaseChannel
// ---------------------------------------------------------------------------

class StubChannel extends BaseChannel {
    readonly name: string;
    readonly authType: AuthType = 'token';

    connectFn = vi.fn().mockResolvedValue(undefined);
    disconnectFn = vi.fn().mockResolvedValue(undefined);
    sendFn = vi.fn().mockResolvedValue('msg-1');
    sendTypingFn = vi.fn().mockResolvedValue(undefined);
    reactFn = vi.fn().mockResolvedValue(undefined);

    constructor(name: string, config: BaseChannelConfig) {
        super(config);
        this.name = name;
    }

    async connect(): Promise<void> {
        return this.connectFn();
    }

    async disconnect(): Promise<void> {
        return this.disconnectFn();
    }

    async send(message: OutboundMessage): Promise<string> {
        return this.sendFn(message);
    }

    async sendTyping(peer: Peer): Promise<void> {
        return this.sendTypingFn(peer);
    }

    async react(options: ReactionOptions): Promise<void> {
        return this.reactFn(options);
    }

    // Expose protected helpers for testing
    public _setStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error'): void {
        this.setStatus(status);
    }

    public _emitError(error: Error): void {
        this.emitError(error);
    }

    public _emit<K extends 'onMessage' | 'onStatusChange' | 'onError' | 'onQR' | 'onAuthUpdate'>(
        event: K,
        ...args: unknown[]
    ): unknown {
        return (this as any).emit(event, ...args);
    }

    public _scheduleReconnect(): void {
        this.scheduleReconnect();
    }

    public _clearReconnect(): void {
        this.clearReconnect();
    }

    public getReconnectAttempts(): number {
        return this.reconnectAttempts;
    }
}

function createChannel(
    name = 'test',
    overrides: Partial<BaseChannelConfig> = {},
): StubChannel {
    return new StubChannel(name, {
        enabled: true,
        dmPolicy: 'open',
        groupPolicy: 'disabled',
        ...overrides,
    });
}

// ---------------------------------------------------------------------------
// on / off / emit
// ---------------------------------------------------------------------------

describe('BaseChannel - on/off/emit', () => {
    let channel: StubChannel;

    beforeEach(() => {
        channel = createChannel();
    });

    it('should register a handler and call it on emit', () => {
        const handler = vi.fn();
        channel.on('onError', handler);
        channel._emitError(new Error('boom'));
        expect(handler).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should replace handler when on() is called again', () => {
        const first = vi.fn();
        const second = vi.fn();
        channel.on('onError', first);
        channel.on('onError', second);
        channel._emitError(new Error('test'));
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalled();
    });

    it('should remove handler on off() only when identity matches', () => {
        const handler = vi.fn();
        channel.on('onError', handler);

        // off with a different function reference should NOT remove
        const otherHandler = vi.fn();
        channel.off('onError', otherHandler);
        channel._emitError(new Error('still works'));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should remove handler on off() when identity matches', () => {
        const handler = vi.fn();
        channel.on('onError', handler);
        channel.off('onError', handler);
        channel._emitError(new Error('nope'));
        expect(handler).not.toHaveBeenCalled();
    });

    it('should return undefined from emit when no handler registered', () => {
        const result = channel._emit('onQR', 'data');
        expect(result).toBeUndefined();
    });

    it('should emit onStatusChange when status changes', () => {
        const handler = vi.fn();
        channel.on('onStatusChange', handler);
        channel._setStatus('connected');
        expect(handler).toHaveBeenCalledWith('connected');
    });

    it('should not emit onStatusChange when status is the same', () => {
        const handler = vi.fn();
        channel.on('onStatusChange', handler);
        // initial status is 'disconnected'
        channel._setStatus('disconnected');
        expect(handler).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// status and config
// ---------------------------------------------------------------------------

describe('BaseChannel - status and config', () => {
    it('should start with disconnected status', () => {
        const channel = createChannel();
        expect(channel.status).toBe('disconnected');
    });

    it('should expose enabled flag', () => {
        const enabled = createChannel('e', { enabled: true });
        const disabled = createChannel('d', { enabled: false });
        expect(enabled.enabled).toBe(true);
        expect(disabled.enabled).toBe(false);
    });

    it('should expose dmPolicy', () => {
        const channel = createChannel('t', { dmPolicy: 'allowlist' });
        expect(channel.dmPolicy).toBe('allowlist');
    });

    it('should default groupPolicy to disabled', () => {
        const channel = createChannel('t', {});
        expect(channel.groupPolicy).toBe('disabled');
    });

    it('should expose groupPolicy when set', () => {
        const channel = createChannel('t', { groupPolicy: 'open' });
        expect(channel.groupPolicy).toBe('open');
    });
});

// ---------------------------------------------------------------------------
// isAllowed
// ---------------------------------------------------------------------------

describe('BaseChannel - isAllowed', () => {
    it('should allow DM when policy is open', () => {
        const channel = createChannel('t', { dmPolicy: 'open' });
        expect(channel.isAllowed('user-1', 'user')).toBe(true);
    });

    it('should block DM when policy is disabled', () => {
        const channel = createChannel('t', { dmPolicy: 'disabled' });
        expect(channel.isAllowed('user-1', 'user')).toBe(false);
    });

    it('should allow DM when policy is allowlist and sender is listed', () => {
        const channel = createChannel('t', {
            dmPolicy: 'allowlist',
            allowFrom: ['user-1', 'user-2'],
        });
        expect(channel.isAllowed('user-1', 'user')).toBe(true);
    });

    it('should block DM when policy is allowlist and sender is not listed', () => {
        const channel = createChannel('t', {
            dmPolicy: 'allowlist',
            allowFrom: ['user-1'],
        });
        expect(channel.isAllowed('user-999', 'user')).toBe(false);
    });

    it('should block DM when policy is allowlist and allowFrom is empty', () => {
        const channel = createChannel('t', { dmPolicy: 'allowlist' });
        expect(channel.isAllowed('user-1', 'user')).toBe(false);
    });

    it('should block sender in blockedFrom regardless of policy', () => {
        const channel = createChannel('t', {
            dmPolicy: 'open',
            blockedFrom: ['bad-user'],
        });
        expect(channel.isAllowed('bad-user', 'user')).toBe(false);
    });

    it('should block group when groupPolicy is disabled', () => {
        const channel = createChannel('t', { groupPolicy: 'disabled' });
        expect(channel.isAllowed('group-1', 'group')).toBe(false);
    });

    it('should allow group when groupPolicy is open', () => {
        const channel = createChannel('t', { groupPolicy: 'open' });
        expect(channel.isAllowed('group-1', 'group')).toBe(true);
    });

    it('should allow group when groupPolicy is allowlist and group is listed', () => {
        const channel = createChannel('t', {
            groupPolicy: 'allowlist',
            allowedGroups: ['group-1'],
        });
        expect(channel.isAllowed('group-1', 'group')).toBe(true);
    });

    it('should block group when groupPolicy is allowlist and group is not listed', () => {
        const channel = createChannel('t', {
            groupPolicy: 'allowlist',
            allowedGroups: ['group-1'],
        });
        expect(channel.isAllowed('group-2', 'group')).toBe(false);
    });

    it('should block group in blockedFrom even when groupPolicy is open', () => {
        const channel = createChannel('t', {
            groupPolicy: 'open',
            blockedFrom: ['group-1'],
        });
        expect(channel.isAllowed('group-1', 'group')).toBe(false);
    });

    describe('pairing policy', () => {
        it('should allow DM when sender is already in allowFrom', () => {
            const channel = createChannel('t', {
                dmPolicy: 'pairing',
                allowFrom: ['user-1'],
            });
            channel.pairingRequestHandler = vi.fn();
            expect(channel.isAllowed('user-1', 'user')).toBe(true);
        });

        it('should invoke pairing handler and return false for unknown sender', () => {
            const pairingHandler = vi.fn();
            const channel = createChannel('t', { dmPolicy: 'pairing' });
            channel.pairingRequestHandler = pairingHandler;

            expect(channel.isAllowed('new-user', 'user')).toBe(false);
            expect(pairingHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    channelName: 't',
                    senderId: 'new-user',
                }),
            );
        });

        it('should block when pairing policy but no handler set', () => {
            const channel = createChannel('t', { dmPolicy: 'pairing' });
            expect(channel.isAllowed('new-user', 'user')).toBe(false);
        });
    });
});

// ---------------------------------------------------------------------------
// updateAccessControl
// ---------------------------------------------------------------------------

describe('BaseChannel - updateAccessControl', () => {
    it('should update dmPolicy', () => {
        const channel = createChannel('t', { dmPolicy: 'open' });
        channel.updateAccessControl({ dmPolicy: 'disabled' });
        expect(channel.dmPolicy).toBe('disabled');
    });

    it('should update allowFrom', () => {
        const channel = createChannel('t', { dmPolicy: 'allowlist' });
        channel.updateAccessControl({ allowFrom: ['user-x'] });
        expect(channel.isAllowed('user-x', 'user')).toBe(true);
    });

    it('should update blockedFrom', () => {
        const channel = createChannel('t', { dmPolicy: 'open' });
        channel.updateAccessControl({ blockedFrom: ['bad-user'] });
        expect(channel.isAllowed('bad-user', 'user')).toBe(false);
    });

    it('should update groupPolicy', () => {
        const channel = createChannel('t', { groupPolicy: 'disabled' });
        channel.updateAccessControl({ groupPolicy: 'open' });
        expect(channel.groupPolicy).toBe('open');
    });

    it('should update allowedGroups', () => {
        const channel = createChannel('t', { groupPolicy: 'allowlist' });
        channel.updateAccessControl({ allowedGroups: ['g1'] });
        expect(channel.isAllowed('g1', 'group')).toBe(true);
    });

    it('should not change fields that are not provided', () => {
        const channel = createChannel('t', {
            dmPolicy: 'open',
            groupPolicy: 'disabled',
        });
        channel.updateAccessControl({ dmPolicy: 'allowlist' });
        expect(channel.groupPolicy).toBe('disabled');
    });
});

// ---------------------------------------------------------------------------
// scheduleReconnect / clearReconnect
// ---------------------------------------------------------------------------

describe('BaseChannel - reconnect', () => {
    it('should set status to error after max attempts', () => {
        vi.useFakeTimers();
        try {
            const channel = createChannel();
            const handler = vi.fn();
            channel.on('onStatusChange', handler);

            // Exhaust all 6 reconnect attempts
            for (let i = 0; i < 6; i++) {
                channel._scheduleReconnect();
            }

            // 7th should trigger error
            channel._scheduleReconnect();
            expect(channel.status).toBe('error');
        } finally {
            vi.useRealTimers();
        }
    });

    it('should set status to connecting during reconnect', () => {
        vi.useFakeTimers();
        try {
            const channel = createChannel();
            channel._scheduleReconnect();
            expect(channel.status).toBe('connecting');
        } finally {
            vi.useRealTimers();
        }
    });

    it('should reset attempts on clearReconnect', () => {
        vi.useFakeTimers();
        try {
            const channel = createChannel();
            channel._scheduleReconnect();
            channel._scheduleReconnect();
            expect(channel.getReconnectAttempts()).toBe(2);
            channel._clearReconnect();
            expect(channel.getReconnectAttempts()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

// ---------------------------------------------------------------------------
// toError utility
// ---------------------------------------------------------------------------

describe('toError', () => {
    it('should return the same Error if given an Error', () => {
        const err = new Error('test');
        expect(toError(err)).toBe(err);
    });

    it('should wrap a string into an Error', () => {
        const err = toError('something broke');
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('something broke');
    });

    it('should wrap a number into an Error', () => {
        const err = toError(42);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('42');
    });

    it('should wrap null into an Error', () => {
        const err = toError(null);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('null');
    });
});
