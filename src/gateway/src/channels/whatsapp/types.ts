import type { BaseChannelConfig } from '@gateway/core/base-channel';

export interface WhatsAppChannelConfig extends BaseChannelConfig {
    sessionPath?: string;
    contextMessages?: number;
    maxChunkSize?: number;
    sendReadReceipts?: boolean;
    autoTyping?: boolean;
    selfChatMode?: boolean;
}
