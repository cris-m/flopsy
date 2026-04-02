import { createLogger } from '@flopsy/shared';
import type { Peer } from '@gateway/types';
import type { DeliveryTarget, ChannelChecker, ChannelSender } from '../types';

const log = createLogger('delivery-router');

export class ChannelRouter {
    constructor(
        private readonly isChannelConnected: ChannelChecker,
        private readonly sendMessage: ChannelSender,
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

        return {
            delivered: false,
            channelName: target.channelName,
            error: `All delivery channels failed (primary + ${target.fallbacks?.length ?? 0} fallbacks)`,
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
