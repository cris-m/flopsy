import type { BaseChannelConfig } from '@gateway/core/base-channel';

export interface DiscordChannelConfig extends BaseChannelConfig {
    token: string;
    allowedGuilds?: string[];
    allowedChannels?: string[];
}
