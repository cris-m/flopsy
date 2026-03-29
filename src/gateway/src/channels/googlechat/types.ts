import type { BaseChannelConfig } from '@gateway/types';

export interface GoogleChatChannelConfig extends BaseChannelConfig {
    /** Path to the service account JSON key file. */
    serviceAccountKeyPath?: string;
    /** Inline service account credentials (alternative to serviceAccountKeyPath). */
    serviceAccountKey?: ServiceAccountKey;
    /** Verification token sent by Google Chat in webhook requests. */
    verificationToken?: string;
    /** Webhook path for receiving events. Default: '/webhook/googlechat'. */
    webhookPath?: string;
    /** How to activate in spaces: 'mention' requires @bot, 'always' processes all. */
    groupActivation?: 'mention' | 'always';
}

export interface ServiceAccountKey {
    client_email: string;
    private_key: string;
    token_uri?: string;
}

export interface GoogleChatEvent {
    type: string;
    eventTime?: string;
    message?: {
        name?: string;
        text?: string;
        argumentText?: string;
        createTime?: string;
        annotations?: Array<{ type: string }>;
    };
    space?: {
        name?: string;
        type?: string;
        displayName?: string;
    };
    user?: {
        name?: string;
        displayName?: string;
    };
}
