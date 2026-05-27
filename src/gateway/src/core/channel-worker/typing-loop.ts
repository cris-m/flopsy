import type { Logger } from 'pino';
import type { Channel, Peer } from '../../types/channel';

/**
 * 4s sits under Telegram's 5s typing-action expiry. Channels without a
 * `typing` capability simply ignore start() calls — the helper still creates
 * a noop interval so the lifecycle is uniform.
 */
const TYPING_REFRESH_MS = 4_000;

export interface TypingLoopDeps {
    readonly channel: Channel;
    readonly log: Logger;
}

/**
 * Repeats `channel.sendTyping(peer)` every 4s while the loop is running.
 * Single-peer at a time: starting with a new peer is silently a no-op until
 * `stop()` is called. Errors from `sendTyping` are logged-and-swallowed —
 * a flaky typing API must not crash the turn.
 */
export class TypingLoop {
    private interval: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly deps: TypingLoopDeps) {}

    start(peer: Peer): void {
        if (this.interval) return;
        void this.sendOnce(peer);
        this.interval = setInterval(() => {
            void this.sendOnce(peer);
        }, TYPING_REFRESH_MS);
        this.interval.unref();
    }

    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    isRunning(): boolean {
        return this.interval !== null;
    }

    async refresh(peer: Peer): Promise<void> {
        if (!(this.deps.channel.capabilities ?? []).includes('typing')) return;
        await this.sendOnce(peer);
    }

    private async sendOnce(peer: Peer): Promise<void> {
        try {
            await this.deps.channel.sendTyping(peer);
        } catch (err) {
            this.deps.log.debug(
                { err: err instanceof Error ? err.message : String(err), peer: peer.id },
                'sendTyping failed',
            );
        }
    }
}
