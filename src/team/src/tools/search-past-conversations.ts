/**
 * search_past_conversations — full-text search across a user's prior turns.
 *
 * Backed by state.db's `messages` table + FTS5 index (see LearningStore).
 * Returns ranked excerpts with timestamps and thread ids so the agent can
 * recall "did I mention X last week?" or "what were we working on around
 * Tuesday?" without re-asking the user.
 *
 * Scoping: ALWAYS user-scoped. The tool reads `userId` from ctx.configurable
 * so results can't leak across users on a multi-tenant gateway. An optional
 * `scope: 'thread'` narrows it further to the current conversation.
 *
 * Wiring contract:
 *   ctx.configurable reads:
 *     - userId    — owner of the history to search (mandatory)
 *     - threadId  — current conversation id, used when scope='thread'
 *     - store     — LearningStore instance (injected by TeamHandler)
 */

import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import type { LearningStore, MessageSearchHit } from '../harness';

export interface SearchPastConversationsConfigurable {
    userId: string;
    threadId?: string;
    store: LearningStore;
}

/** Max hits returned in one call — keeps the tool's output token-budget sane. */
const MAX_HITS = 20;

/** ms in a day — used to normalise the optional `days` window parameter. */
const MS_PER_DAY = 86_400_000;

export const searchPastConversationsTool = defineTool({
    name: 'search_past_conversations',
    description: [
        'Search the USER\'S prior conversations with you (across threads) for',
        'keywords, phrases, or topics. Use when the user refers to something',
        'they said before ("like I told you last week", "that project we',
        'discussed"), when you need to check if a topic was covered already,',
        'or when you\'re rebuilding context after a fresh session.',
        '',
        'Query is full-text — plain words are AND\'d, quoted phrases match',
        'exactly ("new york"), trailing * does prefix match (pay*). Results',
        'are ranked by relevance with a recency tie-breaker.',
        '',
        'Scope defaults to ALL the user\'s past threads. Set scope="thread"',
        'to restrict to the current conversation (useful for "what did I say',
        'earlier in this chat"). Set days=N to only return matches from the',
        'last N days.',
        '',
        'Returns up to `limit` hits (default 10, max 20), each with thread id,',
        'role (user/assistant), an excerpt around the match, and the date.',
        'Zero hits means no match — treat that as "no prior context" rather',
        'than fabricating a memory.',
    ].join('\n'),
    schema: z.object({
        query: z
            .string()
            .min(1)
            .max(500)
            .describe(
                'Search terms. Plain words are AND\'d; use "quoted phrases" for exact matches, trailing * for prefix.',
            ),
        scope: z
            .enum(['all', 'thread'])
            .optional()
            .describe(
                'all = across every conversation with this user; thread = only the current conversation. Default: all.',
            ),
        days: z
            .number()
            .int()
            .positive()
            .max(365)
            .optional()
            .describe('Only return matches from the last N days (1-365).'),
        limit: z
            .number()
            .int()
            .positive()
            .max(MAX_HITS)
            .optional()
            .describe(`Max hits to return (1-${MAX_HITS}). Default 10.`),
    }),
    execute: async ({ query, scope, days, limit }, ctx) => {
        const cfg = (ctx.configurable ?? {}) as Partial<SearchPastConversationsConfigurable>;
        const { userId, threadId, store } = cfg;
        if (!userId || !store) {
            return 'search_past_conversations: not configured (missing userId or store)';
        }

        const sinceMs = days !== undefined ? Date.now() - days * MS_PER_DAY : undefined;

        let hits: MessageSearchHit[];
        try {
            hits = store.searchMessages(userId, query, {
                threadId: scope === 'thread' ? threadId : undefined,
                limit: limit ?? 10,
                sinceMs,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `search_past_conversations: query failed: ${msg}`;
        }

        if (hits.length === 0) {
            return `No matches found for "${query}" (scope=${scope ?? 'all'}${days !== undefined ? `, last ${days}d` : ''}).`;
        }

        return renderHits(hits, query, scope ?? 'all', threadId);
    },
});

/**
 * Render hits as a compact, scannable block. One line per hit:
 *   - role, date (YYYY-MM-DD), thread marker (• if current, thread id otherwise)
 *   - snippet body on the next line, indented two spaces
 *
 * Snippet already includes FTS5's ‹ › highlight markers; we keep them so the
 * model can see WHAT matched instead of guessing from the surrounding text.
 */
function renderHits(
    hits: ReadonlyArray<MessageSearchHit>,
    query: string,
    scope: 'all' | 'thread',
    currentThreadId: string | undefined,
): string {
    const header = `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}" (scope=${scope}):`;
    const lines: string[] = [header, ''];
    for (const h of hits) {
        const date = new Date(h.createdAt).toISOString().slice(0, 10);
        const marker =
            currentThreadId && h.threadId === currentThreadId ? 'this thread' : h.threadId;
        lines.push(`- [${h.role}] ${date} · ${marker}`);
        lines.push(`  ${h.snippet.replace(/\s+/g, ' ').trim()}`);
    }
    return lines.join('\n');
}
