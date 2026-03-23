import type { BaseChannelConfig } from '@gateway/core/base-channel';

export interface IMessageChannelConfig extends BaseChannelConfig {
    cliPath?: string;
    selfChatMode?: boolean;
}
