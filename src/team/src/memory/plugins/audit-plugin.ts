import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { createLogger } from '@flopsy/shared';
import { defineTool, type BaseTool, type Interceptor, type MemoryWriteAction } from 'flopsygraph';

const log = createLogger('memory-audit-plugin');

export interface MemoryAuditPluginOptions {
    logPath: string;
    maxQueryResults?: number;
}

interface AuditEvent {
    ts: number;
    kind: 'write' | 'read';
    action?: MemoryWriteAction;
    target?: string;
    namespace?: string;
    contentPreview?: string;
    resultCount?: number;
    query?: string;
}

const MAX_PREVIEW_CHARS = 200;
const DEFAULT_MAX_QUERY_RESULTS = 20;

const QuerySchema = z.object({
    kind: z.enum(['write', 'read', 'all']).optional().default('all'),
    target: z.string().optional(),
    namespace: z.string().optional(),
    sinceMs: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(500).optional().default(DEFAULT_MAX_QUERY_RESULTS),
    grep: z.string().min(1).max(200).optional(),
});

export function createMemoryAuditPlugin(opts: MemoryAuditPluginOptions): Interceptor {
    const logPath = opts.logPath;
    const maxQueryResults = opts.maxQueryResults ?? DEFAULT_MAX_QUERY_RESULTS;

    const appendEvent = async (event: AuditEvent): Promise<void> => {
        try {
            if (!existsSync(dirname(logPath))) {
                await mkdir(dirname(logPath), { recursive: true });
            }
            await appendFile(logPath, JSON.stringify(event) + '\n', 'utf8');
        } catch (err) {
            log.debug({ err, logPath }, 'audit append failed (continuing)');
        }
    };

    const previewOf = (content: string): string =>
        content.length > MAX_PREVIEW_CHARS ? content.slice(0, MAX_PREVIEW_CHARS) + '…' : content;

    const auditQueryTool: BaseTool = defineTool({
        name: 'memory_audit_query',
        description:
            'Search the memory audit log — every memory write and read operation across the current FLOPSY_HOME. ' +
            'Use this to investigate: "did I save this fact?", "when did the user last search for X?", ' +
            '"what memory events happened in the last hour?". Returns chronological events (newest first). ' +
            'Filter by kind (write/read), target (user/memory/...), namespace, time window, or grep substring.',
        schema: QuerySchema,
        execute: async (args) => {
            try {
                if (!existsSync(logPath)) {
                    return JSON.stringify({ events: [], total: 0, note: 'audit log empty or not yet created' });
                }
                const raw = await readFile(logPath, 'utf8');
                const lines = raw.split('\n').filter(Boolean);
                const all: AuditEvent[] = [];
                for (const line of lines) {
                    try { all.push(JSON.parse(line) as AuditEvent); } catch { /* skip malformed */ }
                }

                let filtered = all;
                if (args.kind && args.kind !== 'all') {
                    filtered = filtered.filter((e) => e.kind === args.kind);
                }
                if (args.target) {
                    filtered = filtered.filter((e) => e.target === args.target);
                }
                if (args.namespace) {
                    filtered = filtered.filter((e) => e.namespace === args.namespace);
                }
                if (args.sinceMs !== undefined) {
                    const cutoff = args.sinceMs;
                    filtered = filtered.filter((e) => e.ts >= cutoff);
                }
                if (args.grep) {
                    const needle = args.grep.toLowerCase();
                    filtered = filtered.filter((e) => {
                        const haystack = `${e.contentPreview ?? ''} ${e.query ?? ''}`.toLowerCase();
                        return haystack.includes(needle);
                    });
                }

                const limit = Math.min(args.limit ?? DEFAULT_MAX_QUERY_RESULTS, maxQueryResults);
                const slice = filtered.slice(-limit).reverse();
                return JSON.stringify({ events: slice, total: filtered.length, returned: slice.length });
            } catch (err) {
                return JSON.stringify({ error: `audit query failed: ${(err as Error).message}` });
            }
        },
    });

    return {
        name: 'memory-audit',
        priority: 30,
        tools: [auditQueryTool],

        async onMemoryWrite(action, target, content, metadata) {
            await appendEvent({
                ts: Date.now(),
                kind: 'write',
                action,
                target,
                contentPreview: previewOf(content),
                ...(metadata && typeof metadata === 'object' ? { metadata: metadata as Record<string, unknown> } : {}),
            } as AuditEvent);
        },

        async onMemoryRead(query, namespace, results) {
            const event: AuditEvent = {
                ts: Date.now(),
                kind: 'read',
                namespace,
                resultCount: results.length,
            };
            if (query !== undefined) event.query = query;
            await appendEvent(event);
        },
    };
}

export type { AuditEvent };
