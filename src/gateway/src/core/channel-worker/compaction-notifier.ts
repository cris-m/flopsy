import type { Logger } from 'pino';
import { compactionEvents, type CompactionEventWithAgent } from '@flopsy/team';
import type { Channel, Peer } from '../../types/channel';

export interface CompactionNotifierDeps {
    readonly channel: Channel;
    readonly threadId: string;
    readonly log: Logger;
    /** Returns the worker's current active peer — null when no turn is active. */
    getCurrentPeer: () => Peer | null;
}

/**
 * Forwards `compactionEvents` from the team layer to a channel that supports
 * `notifyCompaction`. Filters to events on the worker's base thread or any
 * shadow thread that derives from it (`<base>#<sessionId>` pattern).
 *
 * Lifecycle:  `new CompactionNotifier(deps).start()` → `stop()` on shutdown.
 *             Both are idempotent. `start()` is a no-op when the channel
 *             doesn't implement `notifyCompaction`.
 */
export class CompactionNotifier {
    private listener: ((e: CompactionEventWithAgent) => void) | undefined;

    constructor(private readonly deps: CompactionNotifierDeps) {}

    start(): void {
        const channel = this.deps.channel;
        if (typeof channel.notifyCompaction !== 'function') return;
        if (this.listener) return;
        const notify = channel.notifyCompaction.bind(channel);
        const base = this.deps.threadId;
        this.listener = (event) => {
            const t = event.threadId;
            if (t !== base && !t.startsWith(base + '#')) return;
            const peer = this.deps.getCurrentPeer();
            if (!peer) return;
            try {
                notify(peer.id, event);
            } catch (err) {
                this.deps.log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    'channel notifyCompaction threw',
                );
            }
        };
        compactionEvents.on('compaction', this.listener);
    }

    stop(): void {
        if (!this.listener) return;
        compactionEvents.off('compaction', this.listener);
        this.listener = undefined;
    }
}
