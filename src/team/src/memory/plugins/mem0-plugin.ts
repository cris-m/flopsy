import { z } from 'zod';
import { createLogger } from '@flopsy/shared';
import { defineTool, type BaseTool, type Interceptor } from 'flopsygraph';

const log = createLogger('memory-mem0-plugin');

export type Mem0Fetch = (url: string, init: RequestInit) => Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
}>;

export interface MemoryMem0PluginOptions {
    baseUrl: string;
    userId: string;
    apiKey?: string;
    requestTimeoutMs?: number;
    fetcher?: Mem0Fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TOP_K = 25;

interface Mem0Memory {
    id: string;
    memory: string;
    metadata?: Record<string, unknown>;
    score?: number;
    created_at?: string;
    updated_at?: string;
}

const SearchSchema = z.object({
    query: z
        .string()
        .min(2)
        .max(500)
        .describe(
            'Semantic query about the user. Examples: "what database does the user prefer?", ' +
                '"recent decisions about deployment", "user\'s communication style preferences".',
        ),
    topK: z
        .number()
        .int()
        .positive()
        .max(MAX_TOP_K)
        .optional()
        .default(5)
        .describe(`Max matches to return. Default 5, max ${MAX_TOP_K}.`),
});

const AddSchema = z.object({
    content: z
        .string()
        .min(2)
        .max(4000)
        .describe(
            'The fact to add. Mem0 will INTERNALLY decide ADD / UPDATE / DELETE / NOOP via its own LLM — ' +
                'this is more intelligent than a raw add, the price is a small LLM cost on the Mem0 side.',
        ),
});

const MEM0_SEARCH_DESCRIPTION = `Search the Mem0 external memory backend by semantic meaning. Mem0 stores facts the agent has accumulated, deduplicated via LLM at write time and retrieved via vector + graph hybrid search.

WHEN TO USE
  • The user asks about prior context that the local file memory may not have (Mem0 holds more than 1375/2200 chars).
  • You want Mem0-quality recall (vector + reranking) for a specific topic.
  • You want the agent's memory ACROSS sessions / channels via a single source of truth.

WHEN NOT TO USE
  • The fact is already in the system prompt (\`<agent_memory>\` block) — just read it.
  • You want exact-substring match — use the \`memory\` tool's \`list\`.
  • Vector search alone is fine — use \`vector_search\` (local SQLite + Ollama, no cloud dependency).

RETURNS
  Up to topK matches as { id, memory (the fact), score, created_at, metadata? }. Empty when nothing matched. If Mem0 service is down you'll get a structured error; the agent can fall back to local tools.

REQUIRES Mem0 self-hosted (Docker stack: mem0 + qdrant) or Mem0 cloud + API key. Configure in flopsy.json5 under \`memory.mem0\`.`;

const MEM0_ADD_DESCRIPTION = `Add a fact to Mem0 with INTELLIGENT dedup. Unlike the raw \`memory({add})\` tool — which appends blindly — Mem0 runs its own LLM at write time and decides ADD / UPDATE / DELETE / NOOP against existing Mem0 memories. Use this when you want a "smart write" backed by Mem0's pipeline (which is more mature than our in-house smart_remember tool).

Equivalent local-only alternative: \`smart_remember\` (uses NIM gemma + local SQLite; no external service required).

REQUIRES Mem0 service running (default localhost:8765).`;

class Mem0Client {
    private readonly fetcher: Mem0Fetch;

    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string | undefined,
        private readonly timeoutMs: number,
        fetcher?: Mem0Fetch,
    ) {
        this.fetcher = fetcher ?? (globalThis.fetch as unknown as Mem0Fetch);
    }

    private async request(path: string, init: RequestInit): Promise<unknown> {
        const url = this.baseUrl.replace(/\/+$/, '') + path;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
            const headers: Record<string, string> = {
                'content-type': 'application/json',
                ...(init.headers as Record<string, string> | undefined),
            };
            if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
            const res = await this.fetcher(url, { ...init, signal: ctrl.signal, headers });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`mem0 ${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
            }
            return res.json();
        } finally {
            clearTimeout(t);
        }
    }

    async add(userId: string, content: string, metadata?: Record<string, unknown>): Promise<{ id?: string }> {
        const r = await this.request('/v1/memories', {
            method: 'POST',
            body: JSON.stringify({
                messages: [{ role: 'user', content }],
                user_id: userId,
                ...(metadata ? { metadata } : {}),
            }),
        }) as { results?: Array<{ id: string }> };
        return { id: r.results?.[0]?.id };
    }

    async search(userId: string, query: string, limit: number): Promise<Mem0Memory[]> {
        const r = await this.request('/v1/memories/search', {
            method: 'POST',
            body: JSON.stringify({ query, user_id: userId, limit }),
        }) as { results?: Mem0Memory[] };
        return r.results ?? [];
    }
}

export function createMemoryMem0Plugin(opts: MemoryMem0PluginOptions): Interceptor {
    const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const client = new Mem0Client(opts.baseUrl, opts.apiKey, timeoutMs, opts.fetcher);

    const searchTool: BaseTool = defineTool({
        name: 'mem0_search',
        description: MEM0_SEARCH_DESCRIPTION,
        schema: SearchSchema,
        execute: async (args) => {
            try {
                const results = await client.search(opts.userId, args.query, args.topK ?? 5);
                return JSON.stringify({
                    matches: results.map((m) => ({
                        id: m.id,
                        memory: m.memory,
                        score: m.score,
                        created_at: m.created_at,
                    })),
                    user_id: opts.userId,
                });
            } catch (err) {
                return JSON.stringify({
                    error: `mem0_search failed: ${(err as Error).message}`,
                    hint: 'Mem0 service unreachable. Fall back to vector_search or memory list.',
                });
            }
        },
    });

    const addTool: BaseTool = defineTool({
        name: 'mem0_add',
        description: MEM0_ADD_DESCRIPTION,
        schema: AddSchema,
        execute: async (args) => {
            try {
                const r = await client.add(opts.userId, args.content);
                return JSON.stringify({
                    added: true,
                    id: r.id ?? null,
                    note: 'Mem0 may have UPDATEd or NOOPed instead of plain ADD — check Mem0 directly to see what it decided.',
                });
            } catch (err) {
                return JSON.stringify({
                    error: `mem0_add failed: ${(err as Error).message}`,
                    hint: 'Mem0 service unreachable. Use memory({add}) for local-only write.',
                });
            }
        },
    });

    return {
        name: 'memory-mem0',
        priority: 25,
        tools: [searchTool, addTool],

        async onMemoryWrite(action, target, content) {
            if (action !== 'add' && action !== 'upsert' && action !== 'replace' && action !== 'patch') return;
            if (!content || content.trim().length === 0) return;
            try {
                await client.add(opts.userId, content, { source: 'file-mirror', target, action });
            } catch (err) {
                log.debug({ err, action, target }, 'mem0 mirror failed (continuing)');
            }
        },
    };
}
