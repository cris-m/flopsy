import type { BaseChannelConfig } from '@gateway/core/base-channel';

export interface TelegramChannelConfig extends BaseChannelConfig {
    token: string;
    groupActivation?: 'mention' | 'always';
}
