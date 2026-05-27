import { resolve } from 'node:path';
import { z } from 'zod';
import { resolveFlopsyHome, resolveWorkspacePath } from '@flopsy/shared';
import { EmbedderLoader, type BaseEmbedder, type EmbedderConfig } from 'flopsygraph';

export interface MemoryFilePaths {
    readonly user: string;
    readonly memory: string;
    readonly dir: string;
    readonly db: string;
    readonly auditLog: string;
}

export function getMemoryFilePaths(overrides?: {
    userPath?: string;
    memoryPath?: string;
    dbPath?: string;
    auditLogPath?: string;
}): MemoryFilePaths {
    return {
        user: overrides?.userPath
            ? resolveContainedPath(overrides.userPath, 'files.userPath')
            : resolveWorkspacePath('state', 'memory', 'USER.md'),
        memory: overrides?.memoryPath
            ? resolveContainedPath(overrides.memoryPath, 'files.memoryPath')
            : resolveWorkspacePath('state', 'memory', 'MEMORY.md'),
        dir: resolveWorkspacePath('state', 'memory'),
        db: overrides?.dbPath
            ? resolveContainedPath(overrides.dbPath, 'sqliteMirror.path')
            : resolveWorkspacePath('state', 'memory.db'),
        auditLog: overrides?.auditLogPath
            ? resolveContainedPath(overrides.auditLogPath, 'smartWriter.auditLog')
            : resolveWorkspacePath('state', 'memory', '.smart-write-audit.jsonl'),
    };
}

const PathSchema = z.string().min(1).max(512).refine(
    (v) => !v.includes('\0'),
    'path must not contain null bytes',
);

const FilesSchema = z.object({
    userPath: PathSchema.optional(),
    memoryPath: PathSchema.optional(),
    userCharLimit: z.number().int().positive().max(100_000).optional(),
    memoryCharLimit: z.number().int().positive().max(100_000).optional(),
}).optional();

const EmbedderSchema = z.object({
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(256),
    config: z.record(z.string(), z.unknown()).optional(),
}).optional();

const SqliteMirrorSchema = z.object({
    enabled: z.boolean().optional().default(false),
    path: PathSchema.optional(),
    mirrorOnWrite: z.boolean().optional().default(true),
}).optional();

const SmartWriterSchema = z.object({
    enabled: z.boolean().optional().default(false),
    model: z.string().min(1).max(256).optional(),
    similarityThreshold: z.number().min(0).max(1).optional().default(0.7),
    topK: z.number().int().positive().max(20).optional().default(3),
    auditLog: PathSchema.optional(),
}).optional();

const Mem0Schema = z.object({
    enabled: z.boolean().optional().default(false),
    baseUrl: z.string().url().optional(),
    userId: z.string().min(1).max(128).optional(),
}).optional();

const HonchoSchema = z.object({
    enabled: z.boolean().optional().default(false),
    baseUrl: z.string().url().optional(),
    peerName: z.string().min(1).max(128).optional(),
    aiPeer: z.string().min(1).max(128).optional(),
}).optional();

const AuditSchema = z.object({
    enabled: z.boolean().optional().default(false),
    logPath: PathSchema.optional(),
    maxQueryResults: z.number().int().positive().max(500).optional().default(20),
}).optional();

const SkillSignalsSchema = z.object({
    enabled: z.boolean().optional().default(false),
    model: z.string().min(1).max(256).optional(),
    checkEveryNTurns: z.number().int().positive().max(50).optional().default(8),
    windowSize: z.number().int().positive().max(40).optional().default(8),
    minConfidence: z.number().min(0).max(1).optional().default(0.75),
    proposalsPath: PathSchema.optional(),
}).optional();

const PluginsSchema = z.object({
    audit: AuditSchema,
    sqliteMirror: SqliteMirrorSchema,
    smartWriter: SmartWriterSchema,
    mem0: Mem0Schema,
    honcho: HonchoSchema,
    skillSignals: SkillSignalsSchema,
}).passthrough().optional();

export const MemoryConfigRawSchema = z.object({
    enabled: z.boolean().optional().default(true),
    userProfileEnabled: z.boolean().optional().default(true),
    provider: z.string().min(1).max(64).optional(),
    config: z.unknown().optional(),
    userCharLimit: z.number().int().positive().max(100_000).optional(),
    memoryCharLimit: z.number().int().positive().max(100_000).optional(),
    files: FilesSchema,
    embedder: EmbedderSchema,
    plugins: PluginsSchema,
}).passthrough();

export type MemoryConfigRaw = z.infer<typeof MemoryConfigRawSchema>;

export interface ResolvedMemoryConfig {
    enabled: boolean;
    userProfileEnabled: boolean;
    provider: string;
    files: {
        userPath: string;
        memoryPath: string;
        userCharLimit: number;
        memoryCharLimit: number;
    };
    embedder: { provider: string; model: string; config: EmbedderConfig } | null;
    plugins: {
        audit: {
            enabled: boolean;
            logPath: string;
            maxQueryResults: number;
        };
        sqliteMirror: { enabled: boolean; path: string; mirrorOnWrite: boolean };
        smartWriter: {
            enabled: boolean;
            model: string;
            similarityThreshold: number;
            topK: number;
            auditLog: string;
        };
        mem0: { enabled: boolean; baseUrl: string | null; userId: string | null };
        honcho: {
            enabled: boolean;
            baseUrl: string | null;
            peerName: string | null;
            aiPeer: string | null;
        };
        skillSignals: {
            enabled: boolean;
            model: string;
            checkEveryNTurns: number;
            windowSize: number;
            minConfidence: number;
            proposalsPath: string;
        };
    };
}

export const DEFAULT_USER_CHAR_LIMIT = 1375;
export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
export const DEFAULT_SMART_WRITER_MODEL = 'nvidia:google/gemma-4-31b-it';

function resolveContainedPath(input: string, field: string): string {
    const home = resolveFlopsyHome();
    const abs = resolve(home, input);
    if (abs !== home && !abs.startsWith(home + '/') && !abs.startsWith(home + '\\')) {
        throw new Error(`memory.${field} must stay within FLOPSY_HOME (${home}); got ${input}`);
    }
    return abs;
}

export function parseMemoryConfig(raw: unknown): ResolvedMemoryConfig {
    const parsed = MemoryConfigRawSchema.parse(raw ?? {});
    const p = parsed.plugins ?? {};

    const userCharLimit =
        parsed.files?.userCharLimit ?? parsed.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT;
    const memoryCharLimit =
        parsed.files?.memoryCharLimit ?? parsed.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT;

    const paths = getMemoryFilePaths({
        ...(parsed.files?.userPath ? { userPath: parsed.files.userPath } : {}),
        ...(parsed.files?.memoryPath ? { memoryPath: parsed.files.memoryPath } : {}),
        ...(p.sqliteMirror?.path ? { dbPath: p.sqliteMirror.path } : {}),
        ...(p.smartWriter?.auditLog ? { auditLogPath: p.smartWriter.auditLog } : {}),
    });

    const auditLogPath = p.audit?.logPath
        ? resolveContainedPath(p.audit.logPath, 'plugins.audit.logPath')
        : resolveWorkspacePath('state', 'memory', 'audit.jsonl');

    return {
        enabled: parsed.enabled,
        userProfileEnabled: parsed.userProfileEnabled,
        provider: parsed.provider ?? 'file',
        files: {
            userPath: paths.user,
            memoryPath: paths.memory,
            userCharLimit,
            memoryCharLimit,
        },
        embedder: parsed.embedder
            ? {
                  provider: parsed.embedder.provider,
                  model: parsed.embedder.model,
                  config: parsed.embedder.config ?? {},
              }
            : null,
        plugins: {
            audit: {
                enabled: p.audit?.enabled ?? false,
                logPath: auditLogPath,
                maxQueryResults: p.audit?.maxQueryResults ?? 20,
            },
            sqliteMirror: {
                enabled: p.sqliteMirror?.enabled ?? false,
                path: paths.db,
                mirrorOnWrite: p.sqliteMirror?.mirrorOnWrite ?? true,
            },
            smartWriter: {
                enabled: p.smartWriter?.enabled ?? false,
                model: p.smartWriter?.model ?? DEFAULT_SMART_WRITER_MODEL,
                similarityThreshold: p.smartWriter?.similarityThreshold ?? 0.7,
                topK: p.smartWriter?.topK ?? 3,
                auditLog: paths.auditLog,
            },
            mem0: {
                enabled: p.mem0?.enabled ?? false,
                baseUrl: p.mem0?.baseUrl ?? null,
                userId: p.mem0?.userId ?? null,
            },
            honcho: {
                enabled: p.honcho?.enabled ?? false,
                baseUrl: p.honcho?.baseUrl ?? null,
                peerName: p.honcho?.peerName ?? null,
                aiPeer: p.honcho?.aiPeer ?? null,
            },
            skillSignals: {
                enabled: p.skillSignals?.enabled ?? false,
                model: p.skillSignals?.model ?? DEFAULT_SMART_WRITER_MODEL,
                checkEveryNTurns: p.skillSignals?.checkEveryNTurns ?? 8,
                windowSize: p.skillSignals?.windowSize ?? 8,
                minConfidence: p.skillSignals?.minConfidence ?? 0.75,
                proposalsPath: p.skillSignals?.proposalsPath
                    ? resolveContainedPath(p.skillSignals.proposalsPath, 'plugins.skillSignals.proposalsPath')
                    : resolveWorkspacePath('state', 'skill-proposals.jsonl'),
            },
        },
    };
}

const embedderCache = new Map<string, Promise<BaseEmbedder>>();

export async function resolveEmbedder(
    cfg: ResolvedMemoryConfig,
): Promise<BaseEmbedder | undefined> {
    if (!cfg.embedder) return undefined;
    const cacheKey = `${cfg.embedder.provider}:${cfg.embedder.model}`;
    let pending = embedderCache.get(cacheKey);
    if (!pending) {
        const loader = EmbedderLoader.getInstance();
        pending = loader.from(
            {
                provider: cfg.embedder.provider,
                name: cfg.embedder.model,
                config: cfg.embedder.config,
            },
        );
        embedderCache.set(cacheKey, pending);
    }
    return pending;
}

export function clearEmbedderCache(): void {
    embedderCache.clear();
}
