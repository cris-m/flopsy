import type { BaseChannelConfig } from '@gateway/types';

export interface WhatsAppChannelConfig extends BaseChannelConfig {
    sessionPath?: string;
    contextMessages?: number;
    maxChunkSize?: number;
    sendReadReceipts?: boolean;
    autoTyping?: boolean;
    selfChatMode?: boolean;
}
