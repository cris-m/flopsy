import { z } from 'zod';
import { createLogger } from '@flopsy/shared';
import {
    defineTool,
    SqliteMemoryProvider,
    type BaseTool,
    type Embedder,
    type Interceptor,
    type MemoryResult,
    type MemoryWriteAction,
} from 'flopsygraph';

const log = createLogger('memory-vector-plugin');

export interface MemoryVectorPluginOptions {
    dbPath: string;
    embedder: Embedder;
    defaultTopK?: number;
    minSimilarity?: number;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SIM = 0.5;
const MAX_TOP_K = 20;

const SearchSchema = z.object({
    query: z
        .string()
        .min(2)
        .max(500)
        .describe(
            'Natural-language description of what you are looking for. Phrase it like a question or a topic, ' +
                'not like keywords. Examples: "what tooling does the user prefer for Postgres?", "previous decisions ' +
                'about the Bytepesa stack", "user preferences about communication style".',
        ),
    namespace: z
        .enum(['user', 'memory', 'all'])
        .optional()
        .default('all')
        .describe(
            'Which namespace to search. `user` = stable user-profile facts (name, location, preferences). ' +
                '`memory` = project state and operational notes. `all` = both. Default: all.',
        ),
    topK: z
        .number()
        .int()
        .positive()
        .max(MAX_TOP_K)
        .optional()
        .default(DEFAULT_TOP_K)
        .describe(`How many top matches to return. Default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}.`),
    minSimilarity: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(DEFAULT_MIN_SIM)
        .describe(
            `Minimum cosine similarity (0-1). Default ${DEFAULT_MIN_SIM}. Lower = looser matches but more noise; ` +
                `higher = tighter matches but may return nothing.`,
        ),
});

const VECTOR_SEARCH_DESCRIPTION = `Semantic search across the user's memory using embeddings — finds entries by MEANING, not just keywords. Use this when the agent's frozen-snapshot memory block (the \`<agent_memory>\` injected into the system prompt) doesn't already contain what you need, and you suspect older/longer-tail content might.

WHEN TO USE
  • You think a relevant fact was saved earlier but it's not in the current system prompt block (USER.md/MEMORY.md are char-limited; older content may have been pruned).
  • You want to find facts by topic, not by exact phrase. E.g. searching "user's deployment setup" should match an entry like "Mac dev → Hetzner VPS → Cloudflare".
  • You want similar/related entries, not exact matches. E.g. search "comedy preferences" matches "Favorite Comedian: Dave Chappelle".

WHEN NOT TO USE
  • The fact is OBVIOUSLY already in the system prompt (\`<agent_memory>\` block) — just read it, don't call this tool.
  • You only need exact-string match — use the \`memory\` tool's \`list\` action and grep.
  • You're searching CONVERSATION HISTORY (not durable memory) — use \`search_conversation_history\` instead.

RETURNS
  Up to \`topK\` matches as a ranked list, each with: { namespace, content, similarity (0-1), id }. Highest similarity first. Empty array if nothing exceeds \`minSimilarity\`. Empty result is meaningful — it means the user has no durable memory of the topic.

EXAMPLES
  vector_search({ query: "user's preferred database" })
    → finds "Bytepesa stack: payment-svc on Postgres 16, ORM is Prisma" if relevant

  vector_search({ query: "Tokyo timezone", namespace: "user" })
    → finds USER.md entries about location/timezone

NOTE: This plugin maintains its own index BEHIND the canonical USER.md/MEMORY.md files. Every memory write you do via the \`memory\` tool is automatically mirrored here. You can rely on it being in sync.`;

export function createMemoryVectorPlugin(opts: MemoryVectorPluginOptions): Interceptor {
    const store = new SqliteMemoryProvider(opts.dbPath, {
        embedder: opts.embedder,
        name: 'vector-mirror',
        rejectSecrets: true,
    });
    const defaultTopK = opts.defaultTopK ?? DEFAULT_TOP_K;
    const minSimDefault = opts.minSimilarity ?? DEFAULT_MIN_SIM;

    const mirrorWrite = async (action: MemoryWriteAction, target: string, content: string): Promise<void> => {
        if (!content || content.trim().length === 0) return;
        try {
            if (action === 'add' || action === 'upsert') {
                await store.add({ namespace: target, content });
            } else if (action === 'replace' || action === 'patch') {
                await store.add({ namespace: target, content });
            } else if (action === 'remove') {
                try { await store.remove({ namespace: target, target: content }); } catch { /* nothing matched */ }
            } else if (action === 'move') {
                await store.add({ namespace: target, content });
            }
        } catch (err) {
            log.debug({ err, action, target }, 'vector mirror failed (continuing)');
        }
    };

    const vectorSearchTool: BaseTool = defineTool({
        name: 'vector_search',
        description: VECTOR_SEARCH_DESCRIPTION,
        schema: SearchSchema,
        execute: async (args) => {
            try {
                const topK = Math.min(args.topK ?? defaultTopK, MAX_TOP_K);
                const minSim = args.minSimilarity ?? minSimDefault;
                const ns = args.namespace ?? 'all';

                const namespaces = ns === 'all' ? ['user', 'memory'] : [ns];
                const allResults: MemoryResult[] = [];
                for (const namespace of namespaces) {
                    const part = await store.search({ query: args.query, namespace, limit: topK });
                    allResults.push(...part);
                }

                const filtered = allResults
                    .filter((r) => (r.score ?? 0) >= minSim)
                    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                    .slice(0, topK);

                if (filtered.length === 0) {
                    return JSON.stringify({
                        matches: [],
                        searched_namespaces: namespaces,
                        query: args.query,
                        note: `No durable memory exceeded similarity ${minSim}. The topic may not be saved; ` +
                            `consider whether it belongs in USER.md or MEMORY.md.`,
                    });
                }

                return JSON.stringify({
                    matches: filtered.map((r) => ({
                        namespace: r.namespace,
                        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
                        similarity: Number((r.score ?? 0).toFixed(3)),
                        id: r.id,
                    })),
                    searched_namespaces: namespaces,
                    query: args.query,
                });
            } catch (err) {
                return JSON.stringify({
                    error: `vector_search failed: ${(err as Error).message}`,
                    hint: 'Embedder or SQLite backend may be unavailable. Memory tool (`memory list`) still works.',
                });
            }
        },
    });

    return {
        name: 'memory-vector',
        priority: 35,
        tools: [vectorSearchTool],

        async onMemoryWrite(action, target, content) {
            await mirrorWrite(action, target, content);
        },
    };
}
