import type { StateStore } from './store';
import type { ActivityWindow, ExplicitStatus, UserPresence } from '../types';

const ACTIVE_THRESHOLD_MS = 5 * 60_000;
const IDLE_THRESHOLD_MS = 30 * 60_000;

export class PresenceManager {
    constructor(private store: StateStore) {}

    async recordActivity(): Promise<{
        previousWindow: ActivityWindow;
        currentWindow: ActivityWindow;
        transitioned: boolean;
    }> {
        return this.store.mutate((state) => {
            const now = Date.now();
            const previousWindow = computeActivityWindow(state.presence, now);
            state.presence.lastMessageAt = now;
            state.presence.activityWindow = 'active';
            return {
                previousWindow,
                currentWindow: 'active' as ActivityWindow,
                transitioned: previousWindow === 'away' || previousWindow === 'idle',
            };
        });
    }

    async getActivityWindow(): Promise<ActivityWindow> {
        const presence = await this.store.getPresence();
        return computeActivityWindow(presence, Date.now());
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

function computeActivityWindow(presence: UserPresence, now: number): ActivityWindow {
    if (presence.explicitStatus && presence.statusExpiry && presence.statusExpiry > now) {
        if (presence.explicitStatus === 'dnd') return 'away';
        if (presence.explicitStatus === 'busy') return 'idle';
        if (presence.explicitStatus === 'available') return 'active';
    }

    const elapsed = now - presence.lastMessageAt;
    if (elapsed < ACTIVE_THRESHOLD_MS) return 'active';
    if (elapsed < IDLE_THRESHOLD_MS) return 'idle';
    return 'away';
}
