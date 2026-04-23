import { z } from 'zod';

// ============================================================================
// MODEL CONFIGURATION (Simple provider:name references with per-model config)
// ============================================================================

const modelConfigSchema = z
    .object({
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().min(100).optional(),
        topP: z.number().min(0).max(1).optional(),
        topK: z.number().int().optional(),
        frequencyPenalty: z.number().min(-2).max(2).optional(),
        presencePenalty: z.number().min(-2).max(2).optional(),
        seed: z.number().int().optional(),
        reasoning: z.boolean().optional(),
        baseUrl: z.string().url().optional(),
        stopSequences: z.array(z.string()).optional(),
    })
    .strict()
    .optional();

const modelRefSchema = z.object({
    provider: z.string().min(1),
    name: z.string().min(1),
    config: modelConfigSchema,
});

const modelRoutingSchema = z
    .object({
        enabled: z.boolean().default(true),
        tiers: z.object({
            fast: modelRefSchema,
            balanced: modelRefSchema,
            powerful: modelRefSchema,
        }),
    })
    .optional();

const modelSourceSchema = z.object({
    name: z.string().min(1),
    model: modelRefSchema,
    fallback_models: z.array(modelRefSchema).default([]),
    routing: modelRoutingSchema,
});

const modelsConfigSchema = z.object({}).default({});

// ============================================================================
// CHANNELS & GATEWAY (existing)
// ============================================================================

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
    /**
     * Management HTTP endpoint for CLI live-queries (e.g. `flopsy mgmt status`).
     * Listens on 127.0.0.1 only. Auth via env `FLOPSY_MGMT_TOKEN` (optional —
     * when unset, any localhost caller is trusted since the socket isn't
     * reachable off-box anyway). Defaults to port = gateway.port + 1.
     */
    mgmt: z
        .object({
            enabled: z.boolean().default(true),
            host: z.string().default('127.0.0.1'),
            port: z.number().int().min(1).max(65535).optional(),
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

// Human-in-the-loop approval — thin wrapper over flopsygraph's humanApproval()
// interceptor. When a gated tool is called, the graph pauses via GraphInterrupt
// and the gateway renders a review prompt on the active channel.
const approvalsSchema = z.object({
    // Which tools require approval. Accepts a string[] of tool names or 'all'.
    tools: z.union([z.array(z.string()), z.literal('all')]),
    // Which review actions the user can choose from. Default: all four.
    actions: z
        .array(z.enum(['approve', 'skip', 'revise', 'feedback']))
        .optional(),
});

const agentDefinitionSchema = z.object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    // Only 'main' is load-bearing (team bootstrap looks for it); all
    // other values are informational labels for specialist workers
    // (e.g. 'security', 'media'). Keep 'main' strict, accept any string
    // otherwise so new worker archetypes don't force schema edits.
    type: z.string().default('main'),
    domain: z.string().optional(),
    config: z.record(z.unknown()).optional(),

    // Model: "provider:name" format (e.g., "anthropic:claude-3-5-sonnet")
    model: z.string().optional(),
    // Per-model config overrides (temperature, maxTokens, etc.)
    model_config: modelConfigSchema,
    // Fallback models in priority order
    fallback_models: z.array(modelRefSchema).default([]),
    // Cost tier for model selection: low=faster/cheaper, high=more capable
    cost_tier: z.enum(['low', 'medium', 'high']).default('medium'),
    // Tier-routed model aliases (fast / balanced / powerful) — the LLM can
    // request a specific tier for a sub-task; absent tier → fall through to
    // `model` as the default.
    routing: modelRoutingSchema,

    // Named toolset bundles the agent subscribes to. Resolved at runtime via
    // the TOOLSETS registry (src/agent/src/tools/index.ts). Unknown names fail
    // loud at startup.
    toolsets: z.array(z.string()).default([]),

    // Optional path (relative to FLOPSY_HOME) to a markdown prompt file that
    // overrides the default built-in prompt for this agent's `type`.
    promptPath: z.string().optional(),

    // Human-in-the-loop tool approval. Absent → tools run unattended.
    approvals: approvalsSchema.optional(),

    // Role in the fellowship.
    //   'main'   — the gateway entry point (exactly one per config). Gets
    //              send_message + spawn_background_task + delegate_task
    //              auto-injected on top of `toolsets`.
    //   'worker' — a named teammate the main agent can delegate to. Runs
    //              ephemeral per sub-task; does not talk to the user directly
    //              and does not get delegation tools (max depth = 1).
    // Defaults from `type`: type='main' → role='main', otherwise 'worker'.
    role: z.enum(['main', 'worker']).optional(),

    // Which teammate names the main agent is allowed to delegate to. Ignored
    // when role !== 'main'. Each entry must match another agent's `name`.
    // Defaults to every enabled non-main agent at bootstrap.
    workers: z.array(z.string()).optional(),

    // Per-agent MCP server allow-list. When set, ONLY these MCP servers'
    // tools are attached to this agent — overrides the server-side
    // `assignTo` field. When unset (default), the agent receives every
    // MCP server whose `assignTo` includes this agent's name OR "*".
    mcpServers: z.array(z.string()).optional(),

    // Which flopsygraph graph type to build for this agent.
    //   'react'          — default; standard ReactAgent with tools + system prompt.
    //                      Use for main agents and most workers.
    //   'deep-research'  — multi-round search/summarise/reflect pipeline
    //                      (createDeepResearcher). Good for deep-research workers.
    //                      Does NOT support arbitrary tools or our harness/role
    //                      interceptors — its workflow is hardcoded.
    graph: z.enum(['react', 'deep-research']).default('react'),
});

/**
 * Semantic memory store configuration. Backs the `manage_memory` +
 * `search_memory` tools flopsygraph auto-wires into every ReactAgent.
 *
 * When `embedder` is set, an Ollama-backed embedder is wired so
 * `search_memory` does cosine similarity; without it the store falls back
 * to keyed listing. `enabled: false` disables the memory tools entirely.
 */
const memorySchema = z.object({
    enabled: z.boolean().default(true),
    embedder: z
        .object({
            provider: z.enum(['ollama']).default('ollama'),
            model: z.string().default('nomic-embed-text:v1.5'),
            baseUrl: z.string().url().optional(),
        })
        .optional(),
});

/**
 * MCP (Model Context Protocol) server registry. Each entry describes a
 * child-process tool server (stdio) or remote HTTP endpoint that
 * flopsygraph-wired agents can call at runtime.
 *
 * Design choices:
 *   - `requires` gates servers on env-var presence so credentials missing
 *     → server silently disabled with a log, not a crash
 *   - `requiresAuth` points at Layer-1 auth providers (e.g. "google") —
 *     the loader pulls a fresh access_token via getValidAccessToken() and
 *     injects it as FLOPSY_<PROVIDER>_ACCESS_TOKEN before spawning
 *   - `platform` gates OS-specific servers (apple-notes, spotify-darwin)
 *   - `assignTo` routes each server's tool bundle to specific team
 *     members (["gandalf"], ["saruman"], or ["*"] for everyone)
 *   - `env` values support `${VAR}` and `${VAR:-default}` expansion at
 *     spawn time, not parse time, so FLOPSY_HOME / runtime vars land
 */
const mcpServerSchema = z.object({
    enabled: z.boolean().default(true),
    transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
    // stdio transport
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    // http / sse transport
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    // shared
    env: z.record(z.string()).default({}),
    requires: z.array(z.string()).default([]),
    requiresAuth: z.array(z.string()).default([]),
    platform: z.enum(['darwin', 'linux', 'win32']).optional(),
    assignTo: z.array(z.string()).default([]),
    description: z.string().optional(),
    // Full OAuth redirect URI for provider auth flows that need a
    // dashboard-registered URI (e.g. Spotify). Must match exactly what
    // you register in the provider's developer dashboard. The CLI's
    // auth provider parses host+port+path from this one field to bind
    // the local callback listener. Only consulted by `flopsy auth
    // <provider>` — the MCP server itself never reads it.
    redirectBase: z.string().url().optional(),
});

const mcpSchema = z.object({
    enabled: z.boolean().default(true),
    servers: z.record(mcpServerSchema).default({}),
});

export const flopsyConfigSchema = z
    .object({
        workspace: workspaceSchema,
        gateway: gatewaySchema.default({}),
        channels: channelsSchema.default({}),
        webhook: webhookSchema,
        proactive: proactiveSchema,
        logging: loggingSchema.default({}),
        models: modelsConfigSchema.default({}),
        agents: z.array(agentDefinitionSchema).default([]),
        memory: memorySchema.default({}),
        mcp: mcpSchema.default({}),
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
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type ApprovalsConfig = z.infer<typeof approvalsSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type ModelRef = z.infer<typeof modelRefSchema>;
export type ModelRouting = z.infer<typeof modelRoutingSchema>;
export type ModelSource = z.infer<typeof modelSourceSchema>;
export type ModelsConfig = z.infer<typeof modelsConfigSchema>;
export type MemoryConfig = z.infer<typeof memorySchema>;
export type McpConfig = z.infer<typeof mcpSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
