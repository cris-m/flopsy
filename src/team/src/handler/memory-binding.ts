import { createLogger } from '@flopsy/shared';
import type { CheckpointStore, Interceptor as FlopsygraphInterceptor, MemoryProvider, MemoryWriteAction } from 'flopsygraph';
import {
    createMemoryAuditPlugin,
    createMemoryHonchoPlugin,
    createMemoryMem0Plugin,
    createMemorySmartWriterPlugin,
    createMemoryVectorPlugin,
    loadMemoryProvider,
    parseMemoryConfig,
    resolveEmbedder,
} from '../memory';
import { createSkillSignalInterceptor } from '../harness/review';
import { redactSecrets } from './redact';

const log = createLogger('memory-binding');

export type OnMemoryWrite = (
    action: MemoryWriteAction,
    target: string,
    content: string,
    metadata: Readonly<Record<string, unknown>>,
) => void | Promise<void>;

export interface MemoryBindingDeps {
    readonly config: unknown;
    readonly checkpointer: CheckpointStore;
    readonly onMemoryWrite: OnMemoryWrite;
}

/**
 * Owns the memory subsystem state: the lazy `MemoryProvider` + the flopsygraph
 * interceptor plugin list (audit / vector / smart-writer / mem0 / honcho /
 * skill-signals). Both are built lazily and memoized for process lifetime.
 *
 * Single-user-per-workspace warning: `getProvider(userId)` checks the bound
 * userId on first call and emits one warn per offending alt user if a second
 * principal hits the same workspace.
 */
export class MemoryBinding {
    private provider?: MemoryProvider;
    private providerInflight?: Promise<MemoryProvider | undefined>;
    private boundUserId?: string;
    private readonly userMismatchWarned = new Set<string>();
    private pluginsCache: FlopsygraphInterceptor[] | null = null;
    private pluginsPromise: Promise<FlopsygraphInterceptor[]> | null = null;

    constructor(private readonly deps: MemoryBindingDeps) {}

    /**
     * Resolve (and lazy-construct) the memory provider. Single in-flight load
     * promise dedups concurrent first-callers. On failure, falls back to
     * `undefined` so `createTeamMember` can wire its direct file tool.
     */
    getProvider(userId?: string): Promise<MemoryProvider | undefined> {
        if (userId !== undefined) {
            if (this.boundUserId === undefined) {
                this.boundUserId = userId;
            } else if (this.boundUserId !== userId && !this.userMismatchWarned.has(userId)) {
                this.userMismatchWarned.add(userId);
                log.warn(
                    { boundUserId: this.boundUserId, otherUserId: userId },
                    'memory is single-user per FLOPSY_HOME but is being served to a second user; ' +
                        'their USER.md/MEMORY.md will be shared — run one workspace per principal',
                );
            }
        }
        if (this.provider) return Promise.resolve(this.provider);
        if (this.providerInflight) return this.providerInflight;

        const memCfg = (this.deps.config ?? {}) as {
            enabled?: boolean;
            provider?: string;
            config?: unknown;
            userCharLimit?: number;
            memoryCharLimit?: number;
        };

        this.providerInflight = loadMemoryProvider({
            enabled: memCfg.enabled,
            provider: memCfg.provider,
            config: memCfg.config,
            userCharLimit: memCfg.userCharLimit,
            memoryCharLimit: memCfg.memoryCharLimit,
        })
            .then((provider) => {
                this.provider = provider;
                this.providerInflight = undefined;
                this.wireOnMemoryWrite(provider);
                return provider;
            })
            .catch((err: unknown) => {
                log.warn(
                    { err: redactSecrets(err), provider: memCfg.provider ?? 'file' },
                    'memory provider load failed — falling back to direct file tool',
                );
                this.providerInflight = undefined;
                return undefined;
            });

        return this.providerInflight;
    }

    /**
     * Build the flopsygraph memory interceptor plugins from config. Same
     * memoization pattern as `getProvider`: one cache, one in-flight promise.
     */
    buildPlugins(): Promise<FlopsygraphInterceptor[]> {
        if (this.pluginsCache !== null) return Promise.resolve(this.pluginsCache);
        if (this.pluginsPromise) return this.pluginsPromise;

        this.pluginsPromise = (async (): Promise<FlopsygraphInterceptor[]> => {
            let cfg;
            try {
                cfg = parseMemoryConfig((this.deps.config ?? {}) as Record<string, unknown>);
            } catch (err) {
                log.warn(
                    { err: redactSecrets(err) },
                    'memory config parse failed — skipping plugin construction',
                );
                return [];
            }
            const plugins: FlopsygraphInterceptor[] = [];
            const P = cfg.plugins;

            if (P.audit.enabled) {
                plugins.push(
                    createMemoryAuditPlugin({
                        logPath: P.audit.logPath,
                        maxQueryResults: P.audit.maxQueryResults,
                    }),
                );
            }

            const embedder = cfg.embedder
                ? await resolveEmbedder(cfg).catch((err) => {
                      log.warn(
                          { err: redactSecrets(err) },
                          'embedder resolve failed — vector/smart plugins will skip',
                      );
                      return undefined;
                  })
                : undefined;

            if (P.sqliteMirror.enabled) {
                if (!embedder) {
                    log.warn(
                        'memory.plugins.sqliteMirror.enabled=true but embedder unavailable — skipping vector plugin',
                    );
                } else {
                    plugins.push(
                        createMemoryVectorPlugin({
                            dbPath: P.sqliteMirror.path,
                            embedder,
                        }),
                    );
                }
            }

            if (P.smartWriter.enabled) {
                if (!embedder) {
                    log.warn(
                        'memory.plugins.smartWriter.enabled=true but embedder unavailable — skipping smart-writer plugin',
                    );
                } else {
                    const nvApiKey = process.env['NVIDIA_API_KEY'];
                    plugins.push(
                        createMemorySmartWriterPlugin({
                            model: P.smartWriter.model,
                            embedder,
                            dbPath: P.sqliteMirror.path,
                            similarityThreshold: P.smartWriter.similarityThreshold,
                            topK: P.smartWriter.topK,
                            auditLog: P.smartWriter.auditLog,
                            ...(nvApiKey ? { apiKey: nvApiKey } : {}),
                        }),
                    );
                }
            }

            if (P.mem0.enabled) {
                if (!P.mem0.baseUrl || !P.mem0.userId) {
                    log.warn(
                        'memory.plugins.mem0.enabled=true but baseUrl or userId missing — skipping',
                    );
                } else {
                    plugins.push(
                        createMemoryMem0Plugin({
                            baseUrl: P.mem0.baseUrl,
                            userId: P.mem0.userId,
                        }),
                    );
                }
            }

            if (P.honcho.enabled) {
                if (!P.honcho.baseUrl || !P.honcho.peerName || !P.honcho.aiPeer) {
                    log.warn(
                        'memory.plugins.honcho.enabled=true but baseUrl/peerName/aiPeer missing — skipping',
                    );
                } else {
                    plugins.push(
                        createMemoryHonchoPlugin({
                            baseUrl: P.honcho.baseUrl,
                            peerName: P.honcho.peerName,
                            aiPeer: P.honcho.aiPeer,
                        }),
                    );
                }
            }

            if (P.skillSignals.enabled) {
                const nvApiKey = process.env['NVIDIA_API_KEY'];
                try {
                    plugins.push(
                        createSkillSignalInterceptor({
                            model: P.skillSignals.model,
                            checkpointer: this.deps.checkpointer,
                            proposalsPath: P.skillSignals.proposalsPath,
                            checkEveryNTurns: P.skillSignals.checkEveryNTurns,
                            windowSize: P.skillSignals.windowSize,
                            minConfidence: P.skillSignals.minConfidence,
                            ...(nvApiKey ? { apiKey: nvApiKey } : {}),
                        }),
                    );
                } catch (err) {
                    log.warn(
                        { err: redactSecrets(err) },
                        'skill-signal interceptor build failed — skipping',
                    );
                }
            }

            this.pluginsCache = plugins;
            return plugins;
        })();

        return this.pluginsPromise;
    }

    private wireOnMemoryWrite(provider: MemoryProvider | undefined): void {
        if (!provider) return;
        const setter = (provider as unknown as {
            setOnMemoryWrite?: (cb: OnMemoryWrite) => void;
        }).setOnMemoryWrite;
        if (typeof setter !== 'function') return;
        setter.call(provider, this.deps.onMemoryWrite);
    }
}
