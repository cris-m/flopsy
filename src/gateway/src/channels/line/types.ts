import type { BaseChannelConfig } from '@gateway/core/base-channel';

export interface LineChannelConfig extends BaseChannelConfig {
    channelAccessToken: string;
    channelSecret: string;
}
