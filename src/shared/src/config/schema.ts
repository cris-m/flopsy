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

const whatsappSchema = z.object({
    enabled: z.boolean().default(false),
    sessionPath: z.string().default('.flopsy/sessions/whatsapp'),
    dm: dmSchema.default({}),
    group: groupSchema.default({}),
    selfChatMode: z.boolean().default(false),
    sendReadReceipts: z.boolean().default(true),
    autoTyping: z.boolean().default(true),
    contextMessages: z.number().int().min(0).max(200).default(50),
    maxChunkSize: z.number().int().min(100).max(10000).default(4000),
    media: z.object({
        inboundMax: z.number().default(10_485_760),
        outboundMax: z.number().default(10_485_760),
    }).default({}),
    ackReaction: ackReactionSchema,
});

const telegramSchema = z.object({
    enabled: z.boolean().default(false),
    token: z.string().default(''),
    botUsername: z.string().default(''),
    dm: dmSchema.default({}),
    group: groupSchema.default({}),
    ackReaction: ackReactionSchema,
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

const discordSchema = z.object({
    enabled: z.boolean().default(false),
    token: z.string().default(''),
    botUsername: z.string().default(''),
    dm: dmSchema.default({}),
    guild: z.object({
        policy: groupPolicySchema.default('disabled'),
        activation: groupActivationSchema.default('mention'),
        allowedGuilds: z.array(z.string()).default([]),
        allowedChannels: z.array(z.string()).default([]),
    }).default({}),
    ackReaction: ackReactionSchema,
    presence: discordPresenceSchema,
    slashCommands: z.array(discordSlashCommandSchema).default([]),
    devGuildId: z.string().regex(/^\d{17,20}$/).optional(),
});

const lineSchema = z.object({
    enabled: z.boolean().default(false),
    channelAccessToken: z.string().default(''),
    channelSecret: z.string().default(''),
    botName: z.string().default(''),
    webhookPath: z.string().default('/webhook/line'),
    dm: dmSchema.default({}),
    group: groupSchema.default({}),
});

const signalSchema = z.object({
    enabled: z.boolean().default(false),
    account: z.string().default(''),
    cliPath: z.string().default('signal-cli'),
    deviceName: z.string().default('FlopsyBot'),
    sessionPath: z.string().default('.flopsy/sessions/signal'),
    dm: dmSchema.default({}),
    group: groupSchema.default({}),
    ackReaction: ackReactionSchema,
});

const imessageSchema = z.object({
    enabled: z.boolean().default(false),
    cliPath: z.string().default('imsg'),
    selfChatMode: z.boolean().default(false),
    dm: dmSchema.default({}),
});

const channelsSchema = z.object({
    whatsapp: whatsappSchema.default({}),
    telegram: telegramSchema.default({}),
    discord: discordSchema.default({}),
    line: lineSchema.default({}),
    signal: signalSchema.default({}),
    imessage: imessageSchema.default({}),
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
export type LoggingConfig = z.infer<typeof loggingSchema>;
export type WebhookSection = z.infer<typeof webhookSchema>;
