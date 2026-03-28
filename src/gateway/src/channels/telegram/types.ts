import type { BaseChannelConfig } from '@gateway/types';

export interface TelegramChannelConfig extends BaseChannelConfig {
    token: string;
    groupActivation?: 'mention' | 'always';
}
