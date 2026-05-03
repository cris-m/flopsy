import { createLogger } from '@flopsy/shared';
import type { FlopsyConfig, AgentDefinition } from '@flopsy/shared';
import type { BaseChatModel, Observability } from 'flopsygraph';
import { ModelLoader, ModelRouter, registerBuiltInProviders, ensureMultiLanguageImage, probeMultiLanguageImage, createObservability, OTelExporter, detectSpanKindFormat } from 'flopsygraph';
import type { RoutingTable } from 'flopsygraph';
import type { FlopsyGateway } from '@flopsy/gateway';

import { TeamHandler } from './handler';
import type { ThreadIdentity } from './handler';
import { closeSharedLearningStore, getSharedLearningStore } from './harness';
import { SessionExtractor } from './harness/review';
import { loadPersonalities } from './personalities';
import { seedWorkspaceTemplates } from './seed-workspace';
import { setScheduleFacade } from './tools/schedule-registry';

const log = createLogger('bootstrap');

export interface BootstrapOptions {
    /** Override the thread resolver. Default: threadId → userId (single tenant). */
    resolveThread?: (threadId: string) => Promise<ThreadIdentity> | ThreadIdentity;
    /** Pick a specific agent by `name` as the gateway entry point. */
    entryAgentName?: string;
}

export async function startFlopsyBot(
    gateway: FlopsyGateway,
    config: FlopsyConfig,
    opts: BootstrapOptions = {},
): Promise<() => Promise<void>> {
    const definition = opts.entryAgentName
        ? findAgentDefinition(config, opts.entryAgentName)
        : findEntryAgent(config);

    if (!definition) {
        throw new Error(
            `Bootstrap: no entry agent found. Add one with \`type: "main"\` ` +
                `and \`enabled: true\` to the \`agents\` array in flopsy.json5.`,
        );
    }
    if (!definition.enabled) {
        throw new Error(`Bootstrap: agent "${definition.name}" is disabled in config.`);
    }

    log.info(
        {
            team: config.agents.map((a) => ({
                name: a.name,
                type: a.type,
                enabled: a.enabled,
                model: a.model,
            })),
            entry: definition.name,
        },
        'Team roster loaded; entry agent selected',
    );

    log.info(
        {
            name: definition.name,
            primary: definition.model,
            fallbacks: definition.fallback_models?.length ?? 0,
            domain: definition.domain,
        },
        'Loading entry agent model',
    );

    const loader = ModelLoader.getInstance();
    registerBuiltInProviders(loader);

    const otherAgents = config.agents.filter((a) => a.enabled && a.name !== definition.name);
    const allSources = [
        buildModelSource(definition),
        ...otherAgents.map(buildModelSource),
    ];
    const preloadResults = await Promise.all(allSources.map((s) => loader.preload(s)));
    const loaded = preloadResults.flatMap((r) => r.loaded);
    const failed = preloadResults.flatMap((r) => r.failed);
    log.info(
        {
            agents: allSources.length,
            loaded: loaded.length,
            failed: failed.length,
        },
        'team-wide model preload complete',
    );

    if (failed.length > 0) {
        const details = failed.map((f: { ref: unknown; error?: unknown }) => ({
            ref: f.ref,
            error: f.error instanceof Error ? f.error.message : String(f.error),
        }));
        log.warn(
            { failed: details },
            'Some models failed to preload (runtime fallback still possible)',
        );
    }
    if (loaded.length === 0) {
        throw new Error(
            `Bootstrap: no models could be loaded for "${definition.name}". ` +
                `Is the Ollama daemon running on http://localhost:11434? ` +
                `Check: ollama list`,
        );
    }

    // preload's loaded order is unspecified — match primary string explicitly.
    const primaryRef = definition.model
        ? loaded.find((ref) => `${ref.provider}:${ref.name}` === definition.model)
        : undefined;
    const chosen = primaryRef ?? loaded[0];
    const runningOnFallback = primaryRef === undefined;

    const model = await loader.from(chosen);
    log.info(
        {
            model: `${chosen.provider}:${chosen.name}`,
            requested: definition.model,
            runningOnFallback,
        },
        runningOnFallback
            ? 'Primary model unavailable; running on fallback'
            : 'Primary model ready',
    );

    const modelRouters = new Map<string, ModelRouter>();
    for (const agent of config.agents) {
        if (!agent.enabled) continue;
        const router = buildModelRouter(loader, agent);
        if (router) {
            modelRouters.set(agent.name, router);
            log.debug(
                { agent: agent.name, tiers: router.summary() },
                'model router constructed for agent',
            );
        }
    }
    log.info({ routerCount: modelRouters.size }, 'per-agent model routers built');

    const modelRouter = modelRouters.get(definition.name);

    // Run extraction on the fast tier; fall back to primary when unavailable.
    let extractorModel: BaseChatModel = model;
    if (modelRouter) {
        try {
            const fast = await modelRouter.route('fast');
            extractorModel = fast.model;
            log.info(
                { model: `${fast.candidate.ref.provider}:${fast.candidate.ref.name}` },
                'extractor: using fast tier',
            );
        } catch (err) {
            log.warn(
                { err: (err as Error).message },
                'extractor: fast tier unavailable; falling back to primary',
            );
        }
    }
    const sessionExtractor = new SessionExtractor({
        model: extractorModel,
        store: getSharedLearningStore(),
    });

    const seedStats = seedWorkspaceTemplates();
    log.info(seedStats, 'workspace template seed complete');

    const personalities = loadPersonalities();

    await ensureSandboxImageIfNeeded(config);

    const observability = buildObservability();
    if (observability?.enabled) {
        log.info(
            {
                endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
                hasLangSmith: !!process.env.LANGSMITH_API_KEY,
            },
            'observability tracer wired',
        );
    }

    const handler = new TeamHandler({
        team: config.agents,
        entryAgentName: definition.name,
        model,
        resolveThread: opts.resolveThread ?? defaultResolveThread,
        maxThreads: 100,
        memory: config.memory,
        mcp: config.mcp,
        sessionExtractor,
        modelRouter: modelRouter ?? undefined,
        modelRouters,
        personalities,
        ...(observability ? { observability } : {}),
    });

    gateway.setAgentHandler(handler);
    gateway.setStructuredOutputModel(model);
    log.info({ activeThreads: handler.activeThreadCount }, 'Agent handler attached to gateway');

    await gateway.start();
    log.info('Gateway started; awaiting channel traffic');

    // Engine is constructed inside gateway.start(), so this MUST run after.
    const engine = gateway.getProactiveEngine();
    if (engine) {
        setScheduleFacade({
            addRuntimeHeartbeat: (hb, createdBy) => engine.addRuntimeHeartbeat(hb, createdBy),
            addRuntimeCronJob: (job, createdBy) => engine.addRuntimeCronJob(job, createdBy),
            addRuntimeWebhook: (cfg, createdBy) => engine.addRuntimeWebhook(cfg, createdBy),
            removeRuntimeSchedule: (id) => engine.removeRuntimeSchedule(id),
            setRuntimeScheduleEnabled: (id, enabled) => engine.setRuntimeScheduleEnabled(id, enabled),
            replaceRuntimeSchedule: (id, newConfig) => engine.replaceRuntimeSchedule(id, newConfig),
            listSchedules: () => engine.listSchedules(),
        });
        log.info('manage_schedule tool wired to proactive engine');
    }

    return async () => {
        log.info('Tearing down bootstrap');
        setScheduleFacade(null);
        await handler.shutdown();
        closeSharedLearningStore();
        log.info('Bootstrap torn down');
    };
}

function findAgentDefinition(config: FlopsyConfig, name: string): AgentDefinition | undefined {
    return config.agents.find((a) => a.name === name);
}

/**
 * Build an Observability instance from env. Triggers: OTEL_EXPORTER_OTLP_ENDPOINT,
 * LANGSMITH_API_KEY, or FLOPSY_OBSERVABILITY=1. Returns undefined otherwise.
 * OTel exporter requires @opentelemetry/{api,sdk-trace-base} as peer deps.
 */
function buildObservability(): Observability | undefined {
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const langsmithKey = process.env.LANGSMITH_API_KEY;
    const explicitOptIn = process.env.FLOPSY_OBSERVABILITY === '1';
    if (!explicitOptIn && !otlpEndpoint && !langsmithKey) return undefined;

    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'flopsybot';

    try {
        if (otlpEndpoint || langsmithKey) {
            const endpoint =
                otlpEndpoint ?? 'https://api.smith.langchain.com/otel/v1/traces';
            const exporter = new OTelExporter(serviceName, {
                spanKindFormat: detectSpanKindFormat(endpoint),
            });
            return createObservability({ tracing: true, exporters: [exporter] });
        }
        return createObservability({ tracing: true, verbose: true });
    } catch (err) {
        log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'observability wiring failed — continuing without traces',
        );
        return undefined;
    }
}

/**
 * Probe for flopsy-sandbox:latest. If missing, kick off a background build so
 * gateway start doesn't trip the CLI's ~15s health-check (build takes 2-5 min).
 */
async function ensureSandboxImageIfNeeded(config: FlopsyConfig): Promise<void> {
    const needsImage = config.agents.some((a) => {
        const sb = (a as { sandbox?: Record<string, unknown> }).sandbox;
        if (!sb || sb['enabled'] !== true) return false;
        const backend = sb['backend'];
        return backend === 'docker' || backend === 'kubernetes';
    });
    if (!needsImage) return;

    const present = await probeMultiLanguageImage();
    if (present) {
        log.info('sandbox: flopsy-sandbox:latest already built');
        return;
    }

    log.warn(
        'sandbox: flopsy-sandbox:latest not found — starting BACKGROUND build ' +
        '(2-5 min). Gateway boot continues; first sandbox calls fall back to ' +
        'per-language images until the build finishes.',
    );

    void (async () => {
        const result = await ensureMultiLanguageImage({
            onLog: (line) => log.info({ build: 'sandbox' }, line),
        });
        if (result.ready) {
            log.info(
                { durationMs: result.durationMs },
                'sandbox: background build complete; future sessions will use flopsy-sandbox:latest',
            );
        } else {
            log.warn(
                { error: result.error, durationMs: result.durationMs },
                'sandbox: background build failed; daemon keeps falling back to per-language images. ' +
                'Run `flopsy sandbox build` manually to retry.',
            );
        }
    })();
}

function defaultResolveThread(threadId: string): ThreadIdentity {
    // userId is the full peer routing key (`channel:scope:nativeId[:user:senderId]`)
    // so HarnessInterceptor and SessionExtractor land on the same peer_id row.
    const peerId = threadId.split('#')[0] ?? threadId;
    return { userId: peerId };
}

// Split on the FIRST `:` only so Ollama tags like `name:latest` stay attached.
export function parseModelString(s: string): { provider: string; name: string } {
    const i = s.indexOf(':');
    if (i <= 0) {
        throw new Error(
            `Bootstrap: invalid model string "${s}". Expected "provider:name" — e.g. "ollama:glm-4.7-flash:latest".`,
        );
    }
    return { provider: s.slice(0, i), name: s.slice(i + 1) };
}

function buildModelRouter(loader: ModelLoader, def: AgentDefinition): ModelRouter | null {
    if (!def.routing?.enabled || !def.routing.tiers) return null;
    const t = def.routing.tiers;
    const table: RoutingTable = {
        fast:     [{ ref: t.fast }],
        balanced: [{ ref: t.balanced }],
        powerful: [{ ref: t.powerful }],
    };
    if (!table.fast.length && !table.balanced.length && !table.powerful.length) return null;
    return new ModelRouter(loader, table);
}

function buildModelSource(def: AgentDefinition): Parameters<ModelLoader['preload']>[0] {
    if (!def.model) {
        throw new Error(
            `Bootstrap: agent "${def.name}" has no model. Set \`model: "provider:name"\` in flopsy.json5.`,
        );
    }
    const primary = parseModelString(def.model);

    return {
        name: def.name,
        model: {
            provider: primary.provider,
            name: primary.name,
            config: def.model_config,
        },
        fallback_models: def.fallback_models ?? [],
        routing: def.routing,
    } as unknown as Parameters<ModelLoader['preload']>[0];
}

function findEntryAgent(config: FlopsyConfig): AgentDefinition | undefined {
    const enabled = config.agents.filter((a) => a.enabled);
    const mains = enabled.filter((a) => a.type === 'main');

    if (mains.length > 1) {
        log.warn(
            { candidates: mains.map((a) => a.name) },
            `Multiple agents with type='main' — using the first. Give the others a different type.`,
        );
    }
    if (mains.length > 0) return mains[0];
    if (enabled.length === 1) return enabled[0];
    return undefined;
}
