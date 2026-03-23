import type { BaseChannelConfig } from '@gateway/core/base-channel';

export interface SignalChannelConfig extends BaseChannelConfig {
    account: string;
    cliPath?: string;
    deviceName?: string;
    sessionPath?: string;
    groupActivation?: 'mention' | 'always';
}
