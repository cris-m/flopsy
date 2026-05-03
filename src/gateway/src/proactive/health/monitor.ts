import { createLogger } from '@flopsy/shared';
import type { Channel } from '@gateway/types';
import type { ChannelHealthConfig } from '../types';

const log = createLogger('health-monitor');

const DEFAULTS: ChannelHealthConfig = {
    checkIntervalMs: 5 * 60_000,
    staleEventThresholdMs: 10 * 60_000,
    connectGraceMs: 60_000,
    maxRestartsPerHour: 10,
    cooldownCycles: 2,
};

const ONE_HOUR_MS = 60 * 60_000;

interface ChannelHealthState {
    lastEventAt: number;
    connectedAt: number;
    restartsThisHour: number[];
    cooldownRemaining: number;
    restarting: boolean;
}

export class ChannelHealthMonitor {
    private readonly config: ChannelHealthConfig;
    private readonly channelState = new Map<string, ChannelHealthState>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private getChannels: (() => ReadonlyMap<string, Channel>) | null = null;

    constructor(config?: Partial<ChannelHealthConfig>) {
        this.config = { ...DEFAULTS, ...config };
    }

    start(getChannels: () => ReadonlyMap<string, Channel>): void {
        this.getChannels = getChannels;
        this.timer = setInterval(() => this.check(), this.config.checkIntervalMs);
        this.timer.unref();
        log.info({ intervalMs: this.config.checkIntervalMs }, 'Health monitor started');
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.channelState.clear();
        log.info('Health monitor stopped');
    }

    recordEvent(channelName: string): void {
        const state = this.getOrCreateState(channelName);
        state.lastEventAt = Date.now();
    }

    recordConnect(channelName: string): void {
        const state = this.getOrCreateState(channelName);
        state.connectedAt = Date.now();
        state.cooldownRemaining = this.config.cooldownCycles;
    }

    private check(): void {
        if (!this.getChannels) return;
        const now = Date.now();

        for (const [name, channel] of this.getChannels()) {
            if (channel.status !== 'connected') continue;

            const state = this.getOrCreateState(name);

            if (now - state.connectedAt < this.config.connectGraceMs) continue;

            if (state.cooldownRemaining > 0) {
                state.cooldownRemaining--;
                continue;
            }

            const sinceLastEvent = now - state.lastEventAt;
            if (sinceLastEvent < this.config.staleEventThresholdMs) continue;

            state.restartsThisHour = state.restartsThisHour.filter((t) => now - t < ONE_HOUR_MS);

            if (state.restartsThisHour.length >= this.config.maxRestartsPerHour) {
                log.error(
                    { channel: name },
                    'Max restarts reached, channel may be permanently stale',
                );
                continue;
            }

            if (state.restarting) continue;

            log.warn(
                { channel: name, staleSinceMs: sinceLastEvent },
                'Channel appears stale, restarting',
            );

            state.restartsThisHour.push(now);
            state.cooldownRemaining = this.config.cooldownCycles;
            state.restarting = true;

            channel
                .disconnect()
                .then(() => channel.connect())
                .then(() => {
                    const restartedAt = Date.now();
                    state.connectedAt = restartedAt;
                    // Bump lastEventAt to prevent a tick post-cooldown
                    // immediately re-flagging the channel and producing a
                    // restart loop on idle bots.
                    state.lastEventAt = restartedAt;
                    state.restarting = false;
                    log.info({ channel: name }, 'Channel restarted successfully');
                })
                .catch((err) => {
                    state.restarting = false;
                    log.error({ channel: name, err }, 'Channel restart failed');
                });
        }
    }

    private getOrCreateState(channelName: string): ChannelHealthState {
        let state = this.channelState.get(channelName);
        if (!state) {
            state = {
                lastEventAt: Date.now(),
                connectedAt: Date.now(),
                restartsThisHour: [],
                cooldownRemaining: this.config.cooldownCycles,
                restarting: false,
            };
            this.channelState.set(channelName, state);
        }
        return state;
    }
}
