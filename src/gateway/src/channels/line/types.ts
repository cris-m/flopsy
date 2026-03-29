import type { BaseChannelConfig } from '@gateway/types';

export interface LineChannelConfig extends BaseChannelConfig {
    channelAccessToken: string;
    channelSecret: string;
    webhookPath?: string;
}
