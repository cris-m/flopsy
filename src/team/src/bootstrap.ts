/**
 * FlopsyBot bootstrap — wires gateway ⇄ harness-enabled agent.
 *
 * Flow:
 *   1. Load the `main` agent definition from flopsy config
 *   2. Use flopsygraph's ModelLoader to preload the model (+ fallbacks, tiers)
 *   3. Construct a TeamHandler that creates per-thread agents on demand
 *   4. Hand the handler to FlopsyGateway via setAgentHandler()
 *   5. Start the gateway (it will route inbound channel messages to the handler)
 *
 * Returns a teardown callable that flushes per-thread harnesses and closes
 * SQLite on shutdown.
 */

import { createLogger } from '@flopsy/shared';
import type { FlopsyConfig, AgentDefinition } from '@flopsy/shared';
import { ModelLoader, registerBuiltInProviders } from 'flopsygraph';
import type { FlopsyGateway } from '@flopsy/gateway';

import { TeamHandler } from './handler';
import type { ThreadIdentity } from './handler';
import { closeSharedLearningStore } from './harness';
import { setScheduleFacade } from './tools/schedule-registry';

const log = createLogger('bootstrap');

export interface BootstrapOptions {
    /**
     * Override the thread resolver. Default: threadId → userId (single tenant).
     *
     * For multi-tenant setups parse the threadId yourself — e.g. if channel
     * messages were keyed by `channel:peerId`, extract peerId as userId so each
     * user gets isolated learning state.
     */
    resolveThread?: (threadId: string) => Promise<ThreadIdentity> | ThreadIdentity;

    /**
     * Pick a specific agent by `name` as the gateway entry point. By default we
     * find the one enabled agent with `type: 'main'`.
     */
    entryAgentName?: string;
}

/**
 * Wire the harness-enabled entry agent into the gateway and start routing.
 */
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

    // Convert AgentDefinition's string `model` field into a ModelRef that
    // flopsygraph's ModelLoader expects. Without this the preloader reads
    // `.provider` on the raw string and gets `undefined` — leading to
    // "No factory registered for provider 'undefined'" and a permanent
    // fallback-mode bot that sits on a slow cloud model.
    const source = buildModelSource(definition);
    const { loaded, failed } = await loader.preload(source);

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

    // Preload returns loaded models in an unspecified order. If the primary
    // model string matches a loaded entry, prefer it — otherwise we're running
    // on a fallback (already logged via `failed` above).
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

    const handler = new TeamHandler({
        team: config.agents,
        entryAgentName: definition.name,
        model,
        resolveThread: opts.resolveThread ?? defaultResolveThread,
        maxThreads: 100,
        memory: config.memory,
        mcp: config.mcp,
    });

    gateway.setAgentHandler(handler);
    // Expose the raw BaseChatModel so the proactive engine can run flopsygraph's
    // StructuredLLM reformatter on conditional-mode replies. Reusing the main
    // agent's model keeps it in-cache and avoids loading a second provider.
    gateway.setStructuredOutputModel(model);
    log.info({ activeThreads: handler.activeThreadCount }, 'Agent handler attached to gateway');

    await gateway.start();
    log.info('Gateway started; awaiting channel traffic');

    // Wire the manage_schedule agent tool to the live proactive engine. Must
    // happen AFTER gateway.start() — that's when the engine is constructed.
    // If proactive is disabled, getProactiveEngine() returns null and the
    // tool responds with "Scheduler is not running".
    const engine = gateway.getProactiveEngine();
    if (engine) {
        setScheduleFacade({
            addRuntimeHeartbeat: (hb, createdBy) => engine.addRuntimeHeartbeat(hb, createdBy),
            addRuntimeCronJob: (job, createdBy) => engine.addRuntimeCronJob(job, createdBy),
            addRuntimeWebhook: (cfg, createdBy) => engine.addRuntimeWebhook(cfg, createdBy),
            removeRuntimeSchedule: (id) => engine.removeRuntimeSchedule(id),
            setRuntimeScheduleEnabled: (id, enabled) => engine.setRuntimeScheduleEnabled(id, enabled),
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
 * Extract a clean user identifier from a routing key.
 *
 * Routing key formats (from src/gateway/src/core/routing-key.ts):
 *   {channel}:dm:{peerId}
 *   {channel}:group:{peerId}
 *   {channel}:channel:{peerId}
 *   {channel}:group:{peerId}:user:{senderId}     ← per-participant
 *
 * For DMs the peerId IS the user. For group/channel per-participant keys the
 * trailing `:user:{id}` segment carries the sender — prefer that. For group
 * default (no per-participant), fall back to the peerId which identifies the
 * group itself (shared context, no single user).
 */
function defaultResolveThread(threadId: string): ThreadIdentity {
    const parts = threadId.split(':');
    // Per-participant: last two parts are `user`, <id>
    const userIdx = parts.lastIndexOf('user');
    if (userIdx !== -1 && userIdx < parts.length - 1) {
        return { userId: parts[userIdx + 1]! };
    }
    // Default: peerId is the last segment (or the whole key if malformed)
    const peerId = parts[parts.length - 1] ?? threadId;
    return { userId: peerId };
}

/**
 * Split a flopsy-config model string (`"ollama:glm-4.7-flash:latest"`,
 * `"anthropic:claude-sonnet-4-5"`) into the ModelRef shape flopsygraph's
 * ModelLoader expects. The second split is done on the FIRST `:` only, so
 * Ollama tags like `name:latest` stay attached to the model name.
 */
export function parseModelString(s: string): { provider: string; name: string } {
    const i = s.indexOf(':');
    if (i <= 0) {
        throw new Error(
            `Bootstrap: invalid model string "${s}". Expected "provider:name" — e.g. "ollama:glm-4.7-flash:latest".`,
        );
    }
    return { provider: s.slice(0, i), name: s.slice(i + 1) };
}

/**
 * Build the ModelSource object ModelLoader.preload needs from an
 * AgentDefinition. Parses the primary `model` string, carries through
 * already-typed fallback and tier refs.
 */
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

/**
 * The entry agent is the enabled one with `type: 'main'`. If there's
 * more than one, we take the first and warn. If there's none but exactly
 * one agent is enabled, we use that as a fallback.
 */
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
