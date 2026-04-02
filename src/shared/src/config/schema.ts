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

const ackReactionSchema = z
    .object({
        emoji: z.string().default('👀'),
        direct: z.boolean().default(true),
        group: z.enum(['always', 'mentions', 'never']).default('mentions'),
    })
    .optional();

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
    media: z
        .object({
            inboundMax: z.number().default(10_485_760),
            outboundMax: z.number().default(10_485_760),
        })
        .default({}),
});

const telegramSchema = baseChannelSchema.extend({
    group: groupSchema.default({}),
    token: z.string().default(''),
    botUsername: z.string().default(''),
});

const discordPresenceSchema = z
    .object({
        status: z.enum(['online', 'idle', 'dnd', 'invisible']).default('online'),
        activity: z.string().optional(),
        activityType: z
            .enum(['playing', 'streaming', 'listening', 'watching', 'competing'])
            .default('playing'),
        activityUrl: z.string().optional(),
    })
    .optional();

const discordSlashCommandSchema = z.object({
    name: z
        .string()
        .min(1)
        .max(32)
        .regex(/^[\p{Ll}\p{N}-]+$/u, 'Must be lowercase alphanumeric with hyphens'),
    description: z.string().min(1).max(100),
});

const discordSchema = baseChannelSchema.extend({
    token: z.string().default(''),
    botUsername: z.string().default(''),
    guild: z
        .object({
            policy: groupPolicySchema.default('disabled'),
            activation: groupActivationSchema.default('mention'),
            allowedGuilds: z.array(z.string()).default([]),
            allowedChannels: z.array(z.string()).default([]),
        })
        .default({}),
    presence: discordPresenceSchema,
    slashCommands: z.array(discordSlashCommandSchema).default([]),
    devGuildId: z
        .string()
        .regex(/^\d{17,20}$/)
        .optional(),
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
    serviceAccountKey: z
        .object({
            client_email: z.string(),
            private_key: z.string(),
            token_uri: z.string().optional(),
        })
        .optional(),
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
    rateLimit: z
        .object({
            windowMs: z.number().default(60_000),
            maxRequests: z.number().default(100),
            maxConnectionsPerIp: z.number().default(5),
        })
        .default({}),
    deduplication: z
        .object({
            ttlMs: z.number().default(30_000),
            maxEntries: z.number().default(10_000),
        })
        .default({}),
});

const loggingSchema = z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
    pretty: z.boolean().default(false),
    file: z.string().optional(),
    components: z
        .record(z.string(), z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']))
        .default({}),
});

const webhookSchema = z
    .object({
        enabled: z.boolean().default(false),
        port: z.number().int().min(1).max(65535).default(18790),
        host: z.string().default('127.0.0.1'),
        secret: z.string().default(''),
        allowedIps: z.array(z.string()).default([]),
    })
    .default({});

const deliveryTargetSchema = z.object({
    channelName: z.string().min(1),
    peer: z.object({
        id: z.string().min(1),
        type: z.enum(['user', 'group', 'channel']).default('user'),
        name: z.string().optional(),
    }),
    fallbacks: z
        .array(
            z.object({
                channelName: z.string().min(1),
                peer: z.object({
                    id: z.string().min(1),
                    type: z.enum(['user', 'group', 'channel']).default('user'),
                    name: z.string().optional(),
                }),
            }),
        )
        .default([]),
});

const heartbeatDefinitionSchema = z.object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    interval: z.string().min(1),
    prompt: z.string().min(1),
    deliveryMode: z.enum(['always', 'conditional', 'silent']).default('always'),
    activeHours: z
        .object({
            start: z.number().int().min(0).max(23),
            end: z.number().int().min(0).max(23),
        })
        .optional(),
    oneshot: z.boolean().default(false),
    delivery: deliveryTargetSchema.optional(),
});

const cronScheduleSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('at'), atMs: z.number() }),
    z.object({
        kind: z.literal('every'),
        everyMs: z.number().min(1000),
        anchorMs: z.number().optional(),
    }),
    z.object({ kind: z.literal('cron'), expr: z.string().min(1), tz: z.string().optional() }),
]);

const cronPayloadSchema = z.object({
    message: z.string().optional(),
    promptFile: z.string().optional(),
    delivery: deliveryTargetSchema.optional(),
    threadId: z.string().optional(),
    deliveryMode: z.enum(['always', 'conditional', 'silent']).default('always'),
});

const jobDefinitionSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean().default(true),
    schedule: cronScheduleSchema,
    payload: cronPayloadSchema,
    requires: z.array(z.string()).default([]),
});

const healthMonitorSchema = z
    .object({
        enabled: z.boolean().default(true),
        checkIntervalMs: z.number().default(300_000),
        staleEventThresholdMs: z.number().default(600_000),
        connectGraceMs: z.number().default(60_000),
        maxRestartsPerHour: z.number().default(10),
        cooldownCycles: z.number().default(2),
    })
    .default({});

const proactiveSchema = z
    .object({
        enabled: z.boolean().default(false),
        statePath: z.string().default('state/proactive.json'),
        retryQueuePath: z.string().default('state/retry-queue.json'),
        delivery: deliveryTargetSchema.optional(),
        heartbeats: z
            .object({
                enabled: z.boolean().default(false),
                heartbeats: z.array(heartbeatDefinitionSchema).default([]),
            })
            .default({}),
        scheduler: z
            .object({
                enabled: z.boolean().default(false),
                jobs: z.array(jobDefinitionSchema).default([]),
            })
            .default({}),
        webhooks: z.array(externalWebhookSchema).default([]),
        healthMonitor: healthMonitorSchema,
    })
    .default({});

const workspaceSchema = z
    .object({
        root: z.string().optional(),
    })
    .default({});

export const flopsyConfigSchema = z
    .object({
        workspace: workspaceSchema,
        gateway: gatewaySchema.default({}),
        channels: channelsSchema.default({}),
        webhook: webhookSchema,
        proactive: proactiveSchema,
        logging: loggingSchema.default({}),
        timezone: z.string().default('UTC'),
    })
    .strict();

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
export type ProactiveConfig = z.infer<typeof proactiveSchema>;
export type HeartbeatDefinitionConfig = z.infer<typeof heartbeatDefinitionSchema>;
export type JobDefinitionConfig = z.infer<typeof jobDefinitionSchema>;
export type DeliveryTargetConfig = z.infer<typeof deliveryTargetSchema>;
export type HealthMonitorConfig = z.infer<typeof healthMonitorSchema>;
