import { getMemoryRegistry, type MemoryProvider } from 'flopsygraph';
import { fileMemoryProviderManifest } from './file-provider';

export {
    FileMemoryProvider,
    createFileMemoryProvider,
    createMemoryTool,
    fileMemoryProviderManifest,
    type FileMemoryProviderOptions,
    type FileProviderManifestConfig,
} from './file-provider';

export {
    parseMemoryConfig,
    resolveEmbedder,
    clearEmbedderCache,
    getMemoryFilePaths,
    DEFAULT_USER_CHAR_LIMIT,
    DEFAULT_MEMORY_CHAR_LIMIT,
    DEFAULT_SMART_WRITER_MODEL,
    MemoryConfigRawSchema,
    type MemoryConfigRaw,
    type ResolvedMemoryConfig,
    type MemoryFilePaths,
} from './config';

export interface FlopsyMemoryConfig {
    enabled?: boolean;
    userProfileEnabled?: boolean;
    provider?: string;
    config?: unknown;
    userCharLimit?: number;
    memoryCharLimit?: number;
    files?: {
        userPath?: string;
        memoryPath?: string;
        userCharLimit?: number;
        memoryCharLimit?: number;
    };
    embedder?: {
        provider: string;
        model: string;
        config?: Record<string, unknown>;
    };
    plugins?: {
        audit?: { enabled?: boolean; logPath?: string; maxQueryResults?: number };
        sqliteMirror?: { enabled?: boolean; path?: string; mirrorOnWrite?: boolean };
        smartWriter?: {
            enabled?: boolean;
            model?: string;
            similarityThreshold?: number;
            topK?: number;
            auditLog?: string;
        };
        mem0?: { enabled?: boolean; baseUrl?: string; userId?: string };
        honcho?: { enabled?: boolean; baseUrl?: string; peerName?: string; aiPeer?: string };
    };
}

export {
    createMemoryAuditPlugin,
    type MemoryAuditPluginOptions,
    type AuditEvent,
} from './plugins/audit-plugin';

export {
    createMemoryVectorPlugin,
    type MemoryVectorPluginOptions,
} from './plugins/vector-plugin';

export {
    createMemorySmartWriterPlugin,
    type MemorySmartWriterPluginOptions,
    type SmartWriteAuditEntry,
} from './plugins/smart-writer-plugin';

export {
    createMemoryMem0Plugin,
    type MemoryMem0PluginOptions,
    type Mem0Fetch,
} from './plugins/mem0-plugin';

export {
    createMemoryHonchoPlugin,
    type MemoryHonchoPluginOptions,
    type HonchoFetch,
} from './plugins/honcho-plugin';

let manifestsRegistered = false;

/** Register FlopsyBot-owned manifests on the shared registry (idempotent). */
function ensureManifestsRegistered(): void {
    if (manifestsRegistered) return;
    getMemoryRegistry().register(fileMemoryProviderManifest);
    manifestsRegistered = true;
}

/**
 * Load the configured memory provider through flopsygraph's registry. This is
 * the routing seam: instead of hard-constructing the file tool, FlopsyBot
 * resolves `config.memory.provider` to any registered backend (file by
 * default; sqlite/mem0/etc. once their manifests are registered). The flat
 * FlopsyBot memory config is mapped onto the registry's `{enabled, provider,
 * config}` shape, with the char limits folded into the provider config block.
 */
export async function loadMemoryProvider(
    cfg: FlopsyMemoryConfig = {},
): Promise<MemoryProvider> {
    ensureManifestsRegistered();
    const providerConfig: Record<string, unknown> = {
        ...(cfg.config && typeof cfg.config === 'object'
            ? (cfg.config as Record<string, unknown>)
            : {}),
    };

    const userCharLimit = cfg.files?.userCharLimit ?? cfg.userCharLimit;
    const memoryCharLimit = cfg.files?.memoryCharLimit ?? cfg.memoryCharLimit;
    if (userCharLimit !== undefined) providerConfig.userCharLimit = userCharLimit;
    if (memoryCharLimit !== undefined) providerConfig.memoryCharLimit = memoryCharLimit;
    if (cfg.files?.userPath !== undefined) providerConfig.userPath = cfg.files.userPath;
    if (cfg.files?.memoryPath !== undefined) providerConfig.memoryPath = cfg.files.memoryPath;

    return getMemoryRegistry().load(
        {
            enabled: cfg.enabled,
            provider: cfg.provider ?? 'file',
            config: providerConfig,
        },
        {},
    );
}
