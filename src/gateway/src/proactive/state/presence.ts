import type { StateStore } from './store';
import type { ActivityWindow, ExplicitStatus } from '../types';

// Activity windows: active = defer to user, idle = most heartbeats fire,
// away = smart-pulse / briefings become useful.
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const IDLE_WINDOW_MS   = 2 * 60 * 60 * 1000;

function computeActivityWindow(
    nowMs: number,
    lastMessageAtMs: number,
): ActivityWindow {
    if (lastMessageAtMs <= 0) return 'away';
    const elapsed = nowMs - lastMessageAtMs;
    if (elapsed < ACTIVE_WINDOW_MS) return 'active';
    if (elapsed < IDLE_WINDOW_MS)   return 'idle';
    return 'away';
}

export class PresenceManager {
    constructor(private store: StateStore) {}

    async recordUserActivity(nowMs: number = Date.now()): Promise<void> {
        await this.store.mutate((state) => {
            state.presence.lastMessageAt = nowMs;
            state.presence.activityWindow = computeActivityWindow(nowMs, nowMs);
        });
    }

    async setExplicitStatus(
        status: ExplicitStatus,
        durationMs: number,
        reason?: string,
    ): Promise<void> {
        await this.store.mutate((state) => {
            state.presence.explicitStatus = status;
            state.presence.statusExpiry = Date.now() + durationMs;
            state.presence.statusReason = reason;
        });
    }

    async clearExplicitStatus(): Promise<void> {
        await this.store.mutate((state) => {
            state.presence.explicitStatus = undefined;
            state.presence.statusExpiry = undefined;
            state.presence.statusReason = undefined;
        });
    }

    async setQuietHours(untilMs: number): Promise<void> {
        await this.store.mutate((state) => {
            state.presence.quietHoursUntil = untilMs;
        });
    }

    async shouldSuppress(): Promise<{ suppress: boolean; reason?: string }> {
        const presence = await this.store.getPresence();
        const now = Date.now();

        if (presence.quietHoursUntil && now < presence.quietHoursUntil) {
            return { suppress: true, reason: 'quiet hours' };
        }

        if (
            presence.explicitStatus === 'dnd' &&
            presence.statusExpiry &&
            now < presence.statusExpiry
        ) {
            return {
                suppress: true,
                reason: `dnd until ${new Date(presence.statusExpiry).toISOString()}`,
            };
        }

        return { suppress: false };
    }

    async isInActiveHours(start: number, end: number, timezone?: string): Promise<boolean> {
        const tz = timezone ?? process.env.TZ ?? 'UTC';
        const hour = parseInt(
            new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz }),
            10,
        );
        if (start <= end) return hour >= start && hour < end;
        return hour >= start || hour < end;
    }
}
