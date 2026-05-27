import { z } from 'zod';

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
        // Ollama knobs forwarded via `extra_body` on the OpenAI-compat path.
        numCtx: z.number().int().positive().optional(),
        keepAlive: z.string().optional(),
        recursionLimit: z.number().int().positive().optional(),
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
    showThinking: z.boolean().default(false).describe(
        'When true, surface the agent\'s reasoning ("thinking") on this channel ' +
        'as a single edit-in-place message. Default false — matches Hermes/openclaw ' +
        'industry pattern (reasoning lives in observability logs, not chat history).',
    ),
});

const whatsappSchema = baseChannelSchema.extend({
    group: groupSchema.default({}),
    sessionPath: z.string().default('.flopsy/sessions/whatsapp'),
    selfChatMode: z.boolean().default(false),
    sendReadReceipts: z.boolean().default(true),
    autoTyping: z.boolean().default(true),
    contextMessages: z.number().int().min(0).max(200).default(50),
    maxChunkSize: z.number().int().min(100).max(10000).default(4000),
});

const telegramSchema = baseChannelSchema.extend({
    group: groupSchema.default({}),
    token: z.string().default(''),
    botUsername: z.string().default(''),
    streaming: z
        .object({
            /** Live streaming preview — edit placeholder as chunks arrive. */
            enabled: z.boolean().default(true),
            /** 1000ms is the empirical sweet spot — lower triggers 429s; higher loses live feel. */
            minEditIntervalMs: z.number().int().positive().default(1000),
        })
        .default({}),
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
    /** Management HTTP endpoint for CLI live-queries. 127.0.0.1 only; auth via `GATEWAY_TOKEN`. */
    management: z
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

export const heartbeatDefinitionSchema = z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    interval: z.string().min(1),
    prompt: z.string().default(''),
    promptFile: z.string().optional(),
    deliveryMode: z.enum(['always', 'conditional', 'silent']).default('always'),
    activeHours: z
        .object({
            start: z.number().int().min(0).max(23),
            end: z.number().int().min(0).max(23),
        })
        .optional(),
    oneshot: z.boolean().default(false),
    delivery: deliveryTargetSchema.optional(),
    // No-agent / pre-check: tiny scripts gate the fire to cut LLM cost.
    noAgent: z.boolean().default(false),
    script: z.string().optional(),          // path under FLOPSY_HOME/scripts/
    preCheckScript: z.string().optional(),  // path under FLOPSY_HOME/scripts/
    // Skills pre-loaded as authority context; resolved to .flopsy/content/skills/<name>/SKILL.md.
    skills: z.array(z.string().min(1)).optional(),
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
    oneshot: z.boolean().default(false),
    noAgent: z.boolean().default(false),
    script: z.string().optional(),
    preCheckScript: z.string().optional(),
    skills: z.array(z.string().min(1)).optional(),
});

export const jobDefinitionSchema = z.object({
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
        // Path resolution: bare filename ("proactive.json") auto-resolves
        // under <HOME>/state/. Relative paths anchor to FLOPSY_HOME. Absolute
        // paths are honored as-given. See `resolveWorkspaceConfigPath`.
        statePath: z.string().default('proactive.json'),
        retryQueuePath: z.string().default('retry-queue.json'),
        // Consolidated: proactive runtime schedules + deliveries + reported-item
        // dedup share `learning.db` with the harness learning store. Reunites
        // proactive data (proactive_decisions already lived in learning.db) into
        // one file. Distinct table names; safe to share (WAL + busy_timeout).
        dedupDbPath: z.string().default('learning.db'),
        /** Fallback delivery target when a schedule has no explicit `delivery`. */
        delivery: deliveryTargetSchema.optional(),
        /** Auto-route to the channel+peer of the user's most recent inbound message. */
        followActiveChannel: z.boolean().default(false),
        /** Cosine threshold for delivery dedup (bypassed for deliveryMode 'always'). */
        similarityThreshold: z.number().min(0).max(1).default(0.88),
        /** Scan window for similarity dedup. Default 48h. */
        similarityWindowMs: z
            .number()
            .int()
            .positive()
            .default(48 * 60 * 60 * 1000),
        heartbeats: z
            .object({
                enabled: z.boolean().default(false),
            })
            .default({}),
        scheduler: z
            .object({
                enabled: z.boolean().default(false),
            })
            .default({}),
        healthMonitor: healthMonitorSchema,
    })
    .default({});

const workspaceSchema = z
    .object({
        root: z.string().optional(),
    })
    .default({});

// Human-in-the-loop approval — thin wrapper over flopsygraph's humanApproval() interceptor.
const approvalsSchema = z.object({
    tools: z.union([z.array(z.string()), z.literal('all')]),
    actions: z
        .array(z.enum(['approve', 'skip', 'revise', 'feedback']))
        .optional(),
});

/**
 * Per-agent sandbox configuration. `enabled: true` adds an `execute_code` tool;
 * `programmaticToolCalling: true` lets sandboxed code call any of the agent's
 * tools as regular functions (only printed output enters LLM context).
 */
const sandboxConfigSchema = z.object({
    enabled: z.boolean().default(false),
    /** Built-ins: `local`, `docker`, `kubernetes`. Validated at runtime by `createSession`. */
    backend: z.string().default('local'),
    language: z.enum(['python', 'javascript', 'typescript', 'bash']).default('python'),
    /** Hard wall-clock cap on a single execution, in ms. */
    timeout: z.number().int().positive().default(30_000),
    /** RAM ceiling in bytes (Docker/K8s only; ignored for local). */
    memoryLimit: z.number().int().positive().optional(),
    /** CPU shares (Docker/K8s only). */
    cpuLimit: z.number().positive().optional(),
    /** Auto-enabled when `programmaticToolCalling: true` (sandbox needs DNS for the tool bridge). */
    networkEnabled: z.boolean().default(false),
    /** Reuse the session between invocations instead of tearing down. */
    keepAlive: z.boolean().default(true),
    /** Exposes other agent tools as functions to sandboxed code via `use_tools: true`. */
    programmaticToolCalling: z.boolean().default(false),
    /** When true, `local` backend is REFUSED — only docker/kubernetes accepted. */
    untrusted: z.boolean().default(false),
    /** Tier-2 hardening for Docker/K8s: hardened seccomp profile (defense-in-depth over CapDrop). */
    hardened: z.boolean().default(false),
});

const agentDefinitionSchema = z.object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    // Only 'main' is load-bearing; other values are informational labels.
    type: z.string().default('main'),
    domain: z.string().optional(),
    /** Sharp delegation trigger surfaced in the delegate_task/spawn roster, e.g.
     *  "deep multi-source research with citations — state-of-X, comparisons". When
     *  absent the roster falls back to `domain`. */
    whenToUse: z.string().optional(),
    config: z.record(z.unknown()).optional(),

    /** "provider:name" format (e.g., "anthropic:claude-3-5-sonnet"). */
    model: z.string().optional(),
    model_config: modelConfigSchema,
    fallback_models: z.array(modelRefSchema).default([]),
    cost_tier: z.enum(['low', 'medium', 'high']).default('medium'),
    /** Tier aliases (fast/balanced/powerful); absent tier falls through to `model`. */
    routing: modelRoutingSchema,

    /** Resolved at runtime via the TOOLSETS registry; unknown names fail loud at startup. */
    toolsets: z.array(z.string()).default([]),

    /** Path (relative to FLOPSY_HOME) overriding the built-in prompt for this agent's `type`. */
    promptPath: z.string().optional(),

    approvals: approvalsSchema.optional(),

    /** Defaults from `type`: 'main' → 'main'; otherwise 'worker'. */
    role: z.enum(['main', 'worker']).optional(),

    /** Allow-list of worker names. Defaults to every enabled non-main agent. */
    workers: z.array(z.string()).optional(),

    /** Per-agent MCP allow-list; overrides server-side `assignTo`. */
    mcpServers: z.array(z.string()).optional(),

    /** 'react' (default) or 'deep-research' (hardcoded multi-round pipeline). */
    graph: z.enum(['react', 'deep-research']).default('react'),

    sandbox: sandboxConfigSchema.optional(),

    /** Default voice overlay; must match a key in personalities.yaml. */
    defaultPersonality: z.string().optional(),
});

/**
 * Semantic memory store for `manage_memory` + `search_memory` tools.
 * With `embedder`, `search_memory` does cosine similarity; without, keyed listing only.
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
    /** Disables only the user-profile surface (`profile` namespace + USER.md). */
    userProfileEnabled: z.boolean().default(true),
    /** Per-namespace char budget; ~2200 ≈ 800 tokens. 0 disables enforcement. */
    memoryCharLimit: z.number().int().min(0).default(2200),
    /** User-profile char budget (USER.md + `profile` combined); ~1375 ≈ 500 tokens. */
    userCharLimit: z.number().int().min(0).default(1375),
    /**
     * Memory plugins (smartWriter, honcho, mem0, audit, sqliteMirror,
     * skillSignals). Passed through untyped here — the team package owns the
     * authoritative shape via `MemoryConfigRawSchema` (memory/config.ts) and
     * re-validates it in `parseMemoryConfig`. WITHOUT this passthrough, the
     * top-level validate would strip `memory.plugins` and every plugin would
     * silently default to disabled (the bug that made smartWriter a no-op).
     */
    plugins: z.record(z.unknown()).optional(),
});

/**
 * MCP (Model Context Protocol) server registry. Each entry is a stdio child-process
 * or HTTP/SSE endpoint flopsygraph agents can call.
 *
 * - `requires`: env vars gating spawn (missing → disabled with a log).
 * - `requiresAuth`: Layer-1 auth providers; loader injects FLOPSY_<PROVIDER>_ACCESS_TOKEN.
 * - `assignTo`: routes the tool bundle to team members (["*"] for everyone).
 * - `env`: supports `${VAR}` / `${VAR:-default}` expansion at spawn time.
 */
const mcpServerSchema = z.object({
    enabled: z.boolean().default(true),
    transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    env: z.record(z.string()).default({}),
    requires: z.array(z.string()).default([]),
    requiresAuth: z.array(z.string()).default([]),
    platform: z.enum(['darwin', 'linux', 'win32']).optional(),
    assignTo: z.array(z.string()).default([]),
    description: z.string().optional(),
    /** Per-server call timeout. Omit → 30s default. 0 disables (caller hangs forever risk). */
    callTimeoutMs: z.number().int().min(0).optional(),
    /** When true, tools land in the static toolset; otherwise gated behind `__load_tool__`. */
    preload: z.boolean().default(false),
    /** OAuth redirect URI for provider flows (e.g. Spotify); only consulted by `flopsy auth`. */
    redirectBase: z.string().url().optional(),
});

const mcpSchema = z.object({
    enabled: z.boolean().default(true),
    servers: z.record(mcpServerSchema).default({}),
});

const acpAgentSchema = z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).optional(),
});

const acpSchema = z.object({
    enabled: z.boolean().default(false),
    cwdRoot: z.string().default('work/code'),
    permissionMode: z.enum(['auto-allow-in-cwd', 'deny-all']).default('auto-allow-in-cwd'),
    timeoutMs: z.number().int().min(1).default(1_800_000),
    agents: z.record(acpAgentSchema).default({}),
});

export const flopsyConfigSchema = z
    .object({
        workspace: workspaceSchema,
        gateway: gatewaySchema.default({}),
        channels: channelsSchema.default({}),
        webhook: webhookSchema,
        proactive: proactiveSchema,
        logging: loggingSchema.default({}),
        agents: z.array(agentDefinitionSchema).default([]),
        memory: memorySchema.default({}),
        mcp: mcpSchema.default({}),
        acp: acpSchema.default({}),
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
export type MemoryConfig = z.infer<typeof memorySchema>;
export type McpConfig = z.infer<typeof mcpSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
