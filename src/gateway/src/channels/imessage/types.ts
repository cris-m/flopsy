import type { BaseChannelConfig } from '@gateway/types';

export interface IMessageChannelConfig extends BaseChannelConfig {
    cliPath?: string;
    selfChatMode?: boolean;
}
