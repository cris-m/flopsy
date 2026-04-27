import type { StateStore } from './store';
import type { ExplicitStatus } from '../types';

export class PresenceManager {
    constructor(private store: StateStore) {}

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
