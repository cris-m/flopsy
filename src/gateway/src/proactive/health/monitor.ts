import { createLogger } from '@flopsy/shared';
import type { Channel } from '@gateway/types';
import type { ChannelHealthConfig } from '../types';

const log = createLogger('health-monitor');

/**
 * Channel health monitor — status-driven, not time-driven.
 *
 * Rationale (vs. the previous idle-based design):
 *
 *   Reference health-monitor patterns from production
 *   (`gateway/platforms/telegram.py`) leave channels alone when they are
 *   idle. Reconnection is triggered only by REAL transport failures —
 *   One approach: delegate to grammY's runner with a 1h `maxRetryTime` and
 *   exponential backoff; another runs a reconnect ladder on
 *   `isRecoverableTelegramNetworkError` errors and a post-reconnect
 *   heartbeat probe.
 *
 *   The previous version of this monitor reinvented that as time-based
 *   staleness ("no event for 10 min → restart") and the wiring for
 *   `recordEvent` was never connected, so it force-restarted every
 *   channel every ~10 minutes regardless of activity. That dropped
 *   in-flight messages → "chat goes unresponsive after idle".
 *
 *   This rewrite:
 *     - Checks `channel.status` every `checkIntervalMs`. If `connected`,
 *       nothing to do.
 *     - When `channel.status !== 'connected'`, attempt reconnect with
 *       exponential backoff (capped by `maxRestartsPerHour`).
 *     - `recordEvent` is preserved as a public API for callers but no
 *       longer gates anything — useful as telemetry only.
 */

const DEFAULTS: ChannelHealthConfig = {
    // Was 5 min — checking is now cheap (just reading channel.status) so
    // we react faster to real disconnects.
    checkIntervalMs: 30_000,
    // Kept for backward-compat with config schema but unused. The
    // previous idle-restart logic was wrong; idle ≠ broken.
    staleEventThresholdMs: 10 * 60_000,
    // Grace window after a fresh connect before we'd consider intervening.
    connectGraceMs: 30_000,
    // Safety: hard cap on reconnect attempts per rolling hour so a
    // permanently-broken upstream doesn't trigger an infinite restart loop.
    maxRestartsPerHour: 10,
    // Kept for compat — no longer used (was tied to the old time-based path).
    cooldownCycles: 0,
};

const ONE_HOUR_MS = 60 * 60_000;
const RECONNECT_BACKOFF_BASE_MS = 5_000;
const RECONNECT_BACKOFF_MAX_MS = 5 * 60_000;

interface ChannelHealthState {
    /** Kept as telemetry; `recordEvent` writes here but nothing reads it. */
    lastEventAt: number;
    connectedAt: number;
    restartsThisHour: number[];
    /** Last attempted reconnect — used for exponential backoff. */
    lastReconnectAttemptAt: number;
    /** Consecutive failed reconnects (resets on success). Drives backoff. */
    consecutiveReconnectFailures: number;
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
        log.info(
            {
                intervalMs: this.config.checkIntervalMs,
                strategy: 'status-driven',
            },
            'Health monitor started',
        );
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.channelState.clear();
        log.info('Health monitor stopped');
    }

    /**
     * Telemetry-only — records that the channel saw an inbound event.
     * Kept as a public API for callers that want to log channel activity,
     * but it no longer gates restart decisions (the previous design
     * conflated "no events" with "broken", which is wrong: legitimate
     * idle channels also have no events).
     */
    recordEvent(channelName: string): void {
        const state = this.getOrCreateState(channelName);
        state.lastEventAt = Date.now();
    }

    recordConnect(channelName: string): void {
        const state = this.getOrCreateState(channelName);
        state.connectedAt = Date.now();
        state.lastEventAt = Date.now();
        state.consecutiveReconnectFailures = 0;
    }

    private check(): void {
        if (!this.getChannels) return;
        const now = Date.now();

        for (const [name, channel] of this.getChannels()) {
            const state = this.getOrCreateState(name);

            // Healthy channel — leave it alone. This is the core change
            // vs. the previous time-based design.
            if (channel.status === 'connected') continue;

            // Grace after a fresh connect — the channel may still be
            // settling, don't interfere.
            if (now - state.connectedAt < this.config.connectGraceMs) continue;

            // Re-entrancy guard: a reconnect is already in flight.
            if (state.restarting) continue;

            // Exponential backoff between reconnect attempts. Avoids
            // hammering a broken upstream in a tight loop. Backoff scales
            // with consecutive failure count; capped at 5 min.
            const backoffMs = Math.min(
                RECONNECT_BACKOFF_BASE_MS * 2 ** state.consecutiveReconnectFailures,
                RECONNECT_BACKOFF_MAX_MS,
            );
            if (
                state.lastReconnectAttemptAt > 0
                && now - state.lastReconnectAttemptAt < backoffMs
            ) {
                continue;
            }

            // Rolling-hour rate limit. A permanently-broken upstream
            // shouldn't trigger an infinite restart loop.
            state.restartsThisHour = state.restartsThisHour.filter(
                (t) => now - t < ONE_HOUR_MS,
            );
            if (state.restartsThisHour.length >= this.config.maxRestartsPerHour) {
                log.error(
                    {
                        channel: name,
                        status: channel.status,
                        reconnectsThisHour: state.restartsThisHour.length,
                    },
                    'Max reconnects/hr reached — giving up until window slides',
                );
                continue;
            }

            log.warn(
                {
                    channel: name,
                    status: channel.status,
                    consecutiveFailures: state.consecutiveReconnectFailures,
                },
                'Channel not connected — attempting reconnect',
            );

            state.restartsThisHour.push(now);
            state.lastReconnectAttemptAt = now;
            state.restarting = true;

            channel
                .disconnect()
                .then(() => channel.connect())
                .then(() => {
                    const reconnectedAt = Date.now();
                    state.connectedAt = reconnectedAt;
                    state.lastEventAt = reconnectedAt;
                    state.consecutiveReconnectFailures = 0;
                    state.restarting = false;
                    log.info({ channel: name }, 'Channel reconnected successfully');
                })
                .catch((err) => {
                    state.restarting = false;
                    state.consecutiveReconnectFailures += 1;
                    log.error(
                        {
                            channel: name,
                            consecutiveFailures: state.consecutiveReconnectFailures,
                            err,
                        },
                        'Channel reconnect failed — will retry with backoff',
                    );
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
                lastReconnectAttemptAt: 0,
                consecutiveReconnectFailures: 0,
                restarting: false,
            };
            this.channelState.set(channelName, state);
        }
        return state;
    }
}
