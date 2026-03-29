import type { BaseChannelConfig } from '@gateway/types';

export interface SlackChannelConfig extends BaseChannelConfig {
    /** Bot token (xoxb-...) */
    botToken: string;
    /** App-level token for Socket Mode (xapp-...) */
    appToken: string;
    /** Signing secret for webhook verification */
    signingSecret?: string;
    /** How to activate in group channels: 'mention' requires @bot, 'always' processes all. */
    groupActivation?: 'mention' | 'always';
}
