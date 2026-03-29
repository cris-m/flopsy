import { z } from 'zod';

const dmPolicySchema = z.enum(['pairing', 'allowlist', 'open', 'disabled']);
const groupPolicySchema = z.enum(['allowlist', 'open', 'disabled']);
const groupActivationSchema = z.enum(['mention', 'always']);

const dmSchema = z.object({
    policy: dmPolicySchema.default('disabled'),
    allowFrom: z.array(z.string()).default([]),
    blockedFrom: z.array(z.string()).default([]),
});

const groupSchema = z.object({
    policy: groupPolicySchema.default('disabled'),
    activation: groupActivationSchema.default('mention'),
    allowedGroups: z.array(z.string()).default([]),
});

const ackReactionSchema = z.object({
    emoji: z.string().default('👀'),
    direct: z.boolean().default(true),
    group: z.enum(['always', 'mentions', 'never']).default('mentions'),
}).optional();

const baseChannelSchema = z.object({
    enabled: z.boolean().default(false),
    dm: dmSchema.default({}),
    group: groupSchema.optional(),
    ackReaction: ackReactionSchema,
});

const whatsappSchema = baseChannelSchema.extend({
    group: groupSchema.default({}),
    sessionPath: z.string().default('.flopsy/sessions/whatsapp'),
    selfChatMode: z.boolean().default(false),
    sendReadReceipts: z.boolean().default(true),
    autoTyping: z.boolean().default(true),
    contextMessages: z.number().int().min(0).max(200).default(50),
    maxChunkSize: z.number().int().min(100).max(10000).default(4000),
    media: z.object({
        inboundMax: z.number().default(10_485_760),
        outboundMax: z.number().default(10_485_760),
    }).default({}),
});

const telegramSchema = baseChannelSchema.extend({
    group: groupSchema.default({}),
    token: z.string().default(''),
    botUsername: z.string().default(''),
});

const discordPresenceSchema = z.object({
    status: z.enum(['online', 'idle', 'dnd', 'invisible']).default('online'),
    activity: z.string().optional(),
    activityType: z.enum(['playing', 'streaming', 'listening', 'watching', 'competing']).default('playing'),
    activityUrl: z.string().optional(),
}).optional();

const discordSlashCommandSchema = z.object({
    name: z.string().min(1).max(32).regex(/^[\p{Ll}\p{N}-]+$/u, 'Must be lowercase alphanumeric with hyphens'),
    description: z.string().min(1).max(100),
});

const discordSchema = baseChannelSchema.extend({
    token: z.string().default(''),
    botUsername: z.string().default(''),
    guild: z.object({
        policy: groupPolicySchema.default('disabled'),
        activation: groupActivationSchema.default('mention'),
        allowedGuilds: z.array(z.string()).default([]),
        allowedChannels: z.array(z.string()).default([]),
    }).default({}),
    presence: discordPresenceSchema,
    slashCommands: z.array(discordSlashCommandSchema).default([]),
    devGuildId: z.string().regex(/^\d{17,20}$/).optional(),
});

const lineSchema = baseChannelSchema.extend({
    group: groupSchema.default({}),
    channelAccessToken: z.string().default(''),
    channelSecret: z.string().default(''),
    botName: z.string().default(''),
    webhookPath: z.string().default('/webhook/line'),
});

const signalSchema = baseChannelSchema.extend({
    group: groupSchema.default({}),
    account: z.string().default(''),
    cliPath: z.string().default('signal-cli'),
    deviceName: z.string().default('FlopsyBot'),
    sessionPath: z.string().default('.flopsy/sessions/signal'),
});

const imessageSchema = baseChannelSchema.extend({
    cliPath: z.string().default('imsg'),
    selfChatMode: z.boolean().default(false),
});

const slackSchema = baseChannelSchema.extend({
    group: groupSchema.default({}),
    botToken: z.string().default(''),
    appToken: z.string().default(''),
    signingSecret: z.string().default(''),
});

const googlechatSchema = baseChannelSchema.extend({
    group: groupSchema.default({}),
    serviceAccountKeyPath: z.string().optional(),
    serviceAccountKey: z.object({
        client_email: z.string(),
        private_key: z.string(),
        token_uri: z.string().optional(),
    }).optional(),
    verificationToken: z.string().default(''),
    webhookPath: z.string().default('/webhook/googlechat'),
});

const externalWebhookSignatureSchema = z.object({
    header: z.string(),
    algorithm: z.enum(['sha1', 'sha256', 'sha512']).default('sha256'),
    format: z.enum(['hex', 'base64']).default('hex'),
    prefix: z.string().optional(),
});

const externalWebhookSchema = z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    targetChannel: z.string().min(1),
    secret: z.string().optional(),
    signature: externalWebhookSignatureSchema.optional(),
    eventTypeHeader: z.string().optional(),
});

const channelsSchema = z.object({
    whatsapp: whatsappSchema.default({}),
    telegram: telegramSchema.default({}),
    discord: discordSchema.default({}),
    line: lineSchema.default({}),
    signal: signalSchema.default({}),
    imessage: imessageSchema.default({}),
    slack: slackSchema.default({}),
    googlechat: googlechatSchema.default({}),
});

const gatewaySchema = z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(18789),
    token: z.string().default(''),
    coalesceDelayMs: z.number().int().min(0).max(5_000).default(300),
    rateLimit: z.object({
        windowMs: z.number().default(60_000),
        maxRequests: z.number().default(100),
        maxConnectionsPerIp: z.number().default(5),
    }).default({}),
    deduplication: z.object({
        ttlMs: z.number().default(30_000),
        maxEntries: z.number().default(10_000),
    }).default({}),
});

const loggingSchema = z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
    pretty: z.boolean().default(false),
    file: z.string().optional(),
    components: z.record(z.string(), z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])).default({}),
});

const webhookSchema = z.object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65535).default(18790),
    host: z.string().default('127.0.0.1'),
    secret: z.string().default(''),
    allowedIps: z.array(z.string()).default([]),
}).default({});

export const flopsyConfigSchema = z.object({
    gateway: gatewaySchema.default({}),
    channels: channelsSchema.default({}),
    webhook: webhookSchema,
    externalWebhooks: z.array(externalWebhookSchema).default([]),
    logging: loggingSchema.default({}),
    timezone: z.string().default('UTC'),
}).strict();

export type FlopsyConfig = z.infer<typeof flopsyConfigSchema>;
export type ChannelsConfig = z.infer<typeof channelsSchema>;
export type GatewaySection = z.infer<typeof gatewaySchema>;
export type WhatsAppConfig = z.infer<typeof whatsappSchema>;
export type TelegramConfig = z.infer<typeof telegramSchema>;
export type DiscordConfig = z.infer<typeof discordSchema>;
export type LineConfig = z.infer<typeof lineSchema>;
export type SignalConfig = z.infer<typeof signalSchema>;
export type IMessageConfig = z.infer<typeof imessageSchema>;
export type SlackConfig = z.infer<typeof slackSchema>;
export type GoogleChatConfig = z.infer<typeof googlechatSchema>;
export type ExternalWebhookConfigSchema = z.infer<typeof externalWebhookSchema>;
export type LoggingConfig = z.infer<typeof loggingSchema>;
export type WebhookSection = z.infer<typeof webhookSchema>;
