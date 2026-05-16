import { createLogger } from '@flopsy/shared';
import type { Peer } from '@gateway/types';
import type { DeliveryTarget, ChannelChecker, ChannelSender } from '../types';

const log = createLogger('delivery-router');

/**
 * Resolves the engine's current default delivery target (set lazily by
 * `engine.startHeartbeats` / `startCronJobs` AFTER the router is
 * constructed in `engine.start`). Returning `undefined` means no default
 * configured — the router then surfaces the original error unchanged.
 *
 * Why a getter, not a static value: the default target is wired AFTER the
 * router constructor runs (router is built in `start()` before defaults
 * are passed). A getter lets the router resolve the latest value at
 * delivery time without a chicken-and-egg construction problem.
 */
export type DefaultTargetResolver = () => DeliveryTarget | null;

export class ChannelRouter {
    constructor(
        private readonly isChannelConnected: ChannelChecker,
        private readonly sendMessage: ChannelSender,
        /**
         * Optional last-resort target when the per-job `target` AND all its
         * `fallbacks` fail. Resolves engine's `defaultDelivery` at call time
         * so misconfigured jobs (delivery target missing or pointing at a
         * disconnected channel) still get a delivery surface instead of
         * silently retrying forever. Skip the default if the per-job target
         * already IS the default (avoid duplicate attempt).
         */
        private readonly resolveDefaultTarget: DefaultTargetResolver = () => null,
    ) {}

    async deliver(
        target: DeliveryTarget,
        text: string,
    ): Promise<{ delivered: boolean; channelName: string; error?: string }> {
        const attempt = await this.tryDeliver(target.channelName, target.peer, text);
        if (attempt.delivered) return attempt;

        if (target.fallbacks?.length) {
            for (const fallback of target.fallbacks) {
                log.debug(
                    { from: target.channelName, to: fallback.channelName },
                    'Primary delivery failed, trying fallback',
                );
                const fallbackAttempt = await this.tryDeliver(
                    fallback.channelName,
                    fallback.peer,
                    text,
                );
                if (fallbackAttempt.delivered) return fallbackAttempt;
            }
        }

        // Last-resort: engine default. Only attempt if it's actually
        // different from what we already tried (don't double-send on the
        // same channel + peer pair).
        const defaultTarget = this.resolveDefaultTarget();
        if (
            defaultTarget &&
            (defaultTarget.channelName !== target.channelName ||
                defaultTarget.peer.id !== target.peer.id)
        ) {
            log.info(
                {
                    from: target.channelName,
                    to: defaultTarget.channelName,
                    fallbacksTried: target.fallbacks?.length ?? 0,
                },
                'Primary + fallbacks failed, attempting engine default delivery target',
            );
            const defaultAttempt = await this.tryDeliver(
                defaultTarget.channelName,
                defaultTarget.peer,
                text,
            );
            if (defaultAttempt.delivered) return defaultAttempt;
        }

        return {
            delivered: false,
            channelName: target.channelName,
            error: `All delivery channels failed (primary + ${target.fallbacks?.length ?? 0} fallbacks${defaultTarget ? ' + engine default' : ''})`,
        };
    }

    private async tryDeliver(
        channelName: string,
        peer: Peer,
        text: string,
    ): Promise<{ delivered: boolean; channelName: string; error?: string }> {
        if (!this.isChannelConnected(channelName)) {
            return {
                delivered: false,
                channelName,
                error: `Channel ${channelName} not connected`,
            };
        }

        try {
            await this.sendMessage(channelName, peer, text);
            log.info({ channel: channelName, peer: peer.id }, 'Message delivered');
            return { delivered: true, channelName };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error({ channel: channelName, err }, 'Delivery failed');
            return { delivered: false, channelName, error: message };
        }
    }
}
