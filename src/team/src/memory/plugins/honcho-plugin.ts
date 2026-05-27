import { z } from 'zod';
import { createLogger } from '@flopsy/shared';
import { defineTool, type BaseTool, type Interceptor } from 'flopsygraph';

const log = createLogger('memory-honcho-plugin');

export type HonchoFetch = (url: string, init: RequestInit) => Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
}>;

export interface MemoryHonchoPluginOptions {
    baseUrl: string;
    peerName: string;
    aiPeer: string;
    apiKey?: string;
    sessionName?: string;
    workspace?: string;
    requestTimeoutMs?: number;
    fetcher?: HonchoFetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION = 'default';
const DEFAULT_WORKSPACE = 'flopsy';

const SearchSchema = z.object({
    query: z
        .string()
        .min(2)
        .max(500)
        .describe('Semantic search query against Honcho\'s stored conversation context.'),
    limit: z.number().int().positive().max(50).optional().default(5),
});

const ProfileSchema = z.object({
    peer: z
        .enum(['user', 'ai'])
        .optional()
        .default('user')
        .describe('Which peer\'s profile to retrieve. `user` (default) returns the user\'s peer card; `ai` returns the AI\'s self-card.'),
});

const ContextSchema = z.object({
    summary: z.boolean().optional().default(true),
    includeMessages: z.boolean().optional().default(false),
});

const ReasoningSchema = z.object({
    question: z
        .string()
        .min(5)
        .max(500)
        .describe('Question for Honcho to reason about using dialectic LLM passes. Best for synthesis questions like "what patterns has the user shown around X?"'),
    reasoningLevel: z
        .enum(['minimal', 'low', 'medium', 'high'])
        .optional()
        .default('low')
        .describe('Reasoning depth. Higher = better synthesis but slower + more expensive. Default `low` is usually enough.'),
});

const ConcludeSchema = z.object({
    conclusion: z.string().min(2).max(2000).optional(),
    deleteId: z.string().optional(),
}).refine((d) => (d.conclusion && !d.deleteId) || (!d.conclusion && d.deleteId), {
    message: 'Pass exactly one of `conclusion` (to create) or `deleteId` (to delete).',
});

const HONCHO_SEARCH_DESC = `Semantic search across Honcho's stored peer context. Honcho stores ALL conversation history with the user (not just the curated USER.md slice), so this finds details older than what fits in the system prompt.

WHEN TO USE
  • Topic mentioned weeks ago that's NOT in USER.md/MEMORY.md
  • You want raw excerpts (not synthesized) — use honcho_reasoning for synthesis

WHEN NOT TO USE
  • Fact is already in system prompt → just read it
  • Local vector_search would suffice → cheaper, no cloud

RETURNS Array of memory excerpts ranked by relevance. REQUIRES Honcho service.`;

const HONCHO_PROFILE_DESC = `Get Honcho's curated peer card — a snapshot of key facts about a peer. Honcho continuously updates this card as it observes the conversation. \`peer: 'user'\` returns the user's card (their name, role, preferences, communication style). \`peer: 'ai'\` returns the AI's self-representation (which Honcho also builds, modeling YOUR voice and behavior).

Cheap (< 200 tokens of context). Use to check what Honcho currently believes about either peer.`;

const HONCHO_CONTEXT_DESC = `Get the FULL session context from Honcho: summary + user representation + peer card + recent messages. More expensive than honcho_profile but more comprehensive. Use when you need the full picture, not just key facts.`;

const HONCHO_REASONING_DESC = `Ask Honcho a question, get an LLM-synthesized answer. Honcho runs its DIALECTIC passes (multiple .chat() calls that audit + synthesize across the peer's full history). Best for SYNTHESIS questions like:
  • "What patterns has the user shown around late-night work?"
  • "Has the user changed their mind on database choice recently?"
  • "What does the user value most about communication style?"

Bad for FACT LOOKUP — use honcho_search or local memory tools for that.

COST: 1-3 LLM calls server-side. Latency typically 1-5s depending on \`reasoningLevel\`. Honcho's spend, not yours.`;

const HONCHO_CONCLUDE_DESC = `Write a persistent fact about a peer to Honcho's memory, OR delete an existing one for PII removal. Honcho self-heals INCORRECT conclusions over time — you usually don't need to delete unless it's a privacy concern.

In normal use you should NOT call this manually — the memory tool's onMemoryWrite hook auto-mirrors USER.md writes here as Honcho conclusions. Only use \`conclusion\` directly when:
  • The fact is too long for USER.md's 1375-char budget AND you want it stored
  • You want a fact in Honcho ONLY (not in USER.md)

Use \`deleteId\` to remove PII when requested.

REQUIRES exactly ONE of: \`conclusion\` (to create) or \`deleteId\` (to delete).`;

class HonchoClient {
    private readonly fetcher: HonchoFetch;

    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string | undefined,
        private readonly workspace: string,
        private readonly sessionName: string,
        private readonly peerName: string,
        private readonly aiPeer: string,
        private readonly timeoutMs: number,
        fetcher?: HonchoFetch,
    ) {
        this.fetcher = fetcher ?? (globalThis.fetch as unknown as HonchoFetch);
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
                throw new Error(`honcho ${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
            }
            return res.json();
        } finally {
            clearTimeout(t);
        }
    }

    async search(query: string, limit: number): Promise<Array<{ content: string; score?: number }>> {
        const r = await this.request(
            `/v3/workspaces/${this.workspace}/sessions/${this.sessionName}/messages/search`,
            { method: 'POST', body: JSON.stringify({ query, limit, peer: this.peerName }) },
        ) as { results?: Array<{ content: string; score?: number }> };
        return r.results ?? [];
    }

    async profile(peer: 'user' | 'ai'): Promise<{ content: string; meta?: Record<string, unknown> }> {
        const peerName = peer === 'user' ? this.peerName : this.aiPeer;
        const r = await this.request(
            `/v3/workspaces/${this.workspace}/peers/${peerName}/card`,
            { method: 'GET' },
        ) as { card?: string; metadata?: Record<string, unknown> };
        const result: { content: string; meta?: Record<string, unknown> } = {
            content: r.card ?? '',
        };
        if (r.metadata !== undefined) result.meta = r.metadata;
        return result;
    }

    async context(summary: boolean, includeMessages: boolean): Promise<unknown> {
        return this.request(
            `/v3/workspaces/${this.workspace}/sessions/${this.sessionName}/context`,
            { method: 'POST', body: JSON.stringify({ summary, include_messages: includeMessages, peer: this.peerName }) },
        );
    }

    async reasoning(question: string, level: string): Promise<{ answer: string }> {
        const r = await this.request(
            `/v3/workspaces/${this.workspace}/peers/${this.peerName}/chat`,
            { method: 'POST', body: JSON.stringify({ query: question, reasoning_level: level }) },
        ) as { content?: string };
        return { answer: r.content ?? '' };
    }

    async conclude(content: string): Promise<{ id?: string }> {
        const r = await this.request(
            `/v3/workspaces/${this.workspace}/peers/${this.peerName}/conclusions`,
            { method: 'POST', body: JSON.stringify({ conclusion: content }) },
        ) as { id?: string };
        return { id: r.id };
    }

    async deleteConclusion(id: string): Promise<{ deleted: boolean }> {
        await this.request(
            `/v3/workspaces/${this.workspace}/peers/${this.peerName}/conclusions/${id}`,
            { method: 'DELETE' },
        );
        return { deleted: true };
    }
}

export function createMemoryHonchoPlugin(opts: MemoryHonchoPluginOptions): Interceptor {
    const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const client = new HonchoClient(
        opts.baseUrl,
        opts.apiKey,
        opts.workspace ?? DEFAULT_WORKSPACE,
        opts.sessionName ?? DEFAULT_SESSION,
        opts.peerName,
        opts.aiPeer,
        timeoutMs,
        opts.fetcher,
    );

    const wrap = (label: string, fn: () => Promise<unknown>) => async (): Promise<string> => {
        try {
            const r = await fn();
            return JSON.stringify(r);
        } catch (err) {
            return JSON.stringify({
                error: `${label} failed: ${(err as Error).message}`,
                hint: 'Honcho service unreachable. Fall back to local memory tools (memory, vector_search).',
            });
        }
    };

    const searchTool: BaseTool = defineTool({
        name: 'honcho_search',
        description: HONCHO_SEARCH_DESC,
        schema: SearchSchema,
        execute: async (args) => wrap('honcho_search', async () => {
            const results = await client.search(args.query, args.limit ?? 5);
            return { matches: results };
        })(),
    });

    const profileTool: BaseTool = defineTool({
        name: 'honcho_profile',
        description: HONCHO_PROFILE_DESC,
        schema: ProfileSchema,
        execute: async (args) => wrap('honcho_profile', async () => {
            const p = await client.profile(args.peer ?? 'user');
            return { peer: args.peer ?? 'user', card: p.content, meta: p.meta };
        })(),
    });

    const contextTool: BaseTool = defineTool({
        name: 'honcho_context',
        description: HONCHO_CONTEXT_DESC,
        schema: ContextSchema,
        execute: async (args) => wrap('honcho_context', async () => {
            return await client.context(args.summary ?? true, args.includeMessages ?? false);
        })(),
    });

    const reasoningTool: BaseTool = defineTool({
        name: 'honcho_reasoning',
        description: HONCHO_REASONING_DESC,
        schema: ReasoningSchema,
        execute: async (args) => wrap('honcho_reasoning', async () => {
            const r = await client.reasoning(args.question, args.reasoningLevel ?? 'low');
            return { answer: r.answer, question: args.question };
        })(),
    });

    const concludeTool: BaseTool = defineTool({
        name: 'honcho_conclude',
        description: HONCHO_CONCLUDE_DESC,
        schema: ConcludeSchema,
        execute: async (args) => {
            try {
                if (args.deleteId) {
                    await client.deleteConclusion(args.deleteId);
                    return JSON.stringify({ deleted: true, id: args.deleteId });
                }
                const r = await client.conclude(args.conclusion!);
                return JSON.stringify({ created: true, id: r.id ?? null });
            } catch (err) {
                return JSON.stringify({
                    error: `honcho_conclude failed: ${(err as Error).message}`,
                    hint: 'Honcho service unreachable. The local USER.md write succeeded; only the Honcho mirror failed.',
                });
            }
        },
    });

    return {
        name: 'memory-honcho',
        priority: 20,
        tools: [searchTool, profileTool, contextTool, reasoningTool, concludeTool],

        async onMemoryWrite(action, target, content) {
            if (action !== 'add' || target !== 'user' || !content?.trim()) return;
            try { await client.conclude(content); }
            catch (err) { log.debug({ err, target }, 'honcho mirror failed (continuing)'); }
        },
    };
}
