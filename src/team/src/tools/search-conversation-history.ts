/**
 * search_conversation_history — cross-thread substring search + LLM summarization.
 * Scans every thread (no prefix scoping; proactive userIds would otherwise scope to themselves).
 */

import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import type { BaseChatModel, CheckpointStore } from 'flopsygraph';
import { numberLooseOptional } from './schema-coerce';

interface SearchableMessage {
    role?: string;
    content?: unknown;
    createdAt?: number;
}

export interface SearchConversationHistoryConfigurable {
    /** Back-compat field shared with other tools; unused here. */
    userId?: string;
    /** Current thread — excluded from grouping/results. */
    threadId?: string;
    checkpointer: CheckpointStore;
    /** Auxiliary model for per-thread summarisation. */
    summaryModel?: BaseChatModel;
}

const DEFAULT_SESSIONS = 3;
const MAX_SESSIONS = 5;
const MAX_CHARS_PER_SESSION = 30_000;
const MAX_MESSAGES_PER_SESSION = 40;
/** Pulled per query before grouping — covers many threads at once. */
const RAW_SEARCH_LIMIT = 60;

interface SessionBundle {
    threadId: string;
    /** ISO date of the first message in the thread (best-effort). */
    startedAt: string;
    messages: SearchableMessage[];
}

export const searchConversationHistoryTool = defineTool({
    name: 'search_conversation_history',
    description: [
        'Search ALL past conversations for a topic, question, or keyword.',
        'Returns human-readable session summaries — "On May 3 you discussed',
        'X, decided Y, and ran into Z." — not raw excerpts.',
        '',
        'Use when:',
        '- The user asks "what did we talk about last week?"',
        '- You need to rebuild context after /new without asking the user',
        '- The user references a past decision or project by name',
        '- You want to find a specific file, command, or URL from an old session',
        '',
        'Query is case-insensitive substring match against message content.',
        '',
        'Each summary includes: what was asked, actions taken, outcomes,',
        'key details (files/URLs/commands), and session date.',
        '',
        'Returns up to N session summaries ranked by recency. Zero results',
        'means no matching conversation history. Don\'t fabricate a memory.',
        '',
        'Staleness: summaries are from past sessions. When citing a fact that',
        'could have changed (price, status, ownership), verify with a current',
        'tool call before relying on it.',
    ].join('\n'),
    schema: z.object({
        query: z
            .string()
            .min(1)
            .max(500)
            .describe('What are you looking for? Natural language or keywords (substring match).'),
        topSessions: numberLooseOptional()
            .pipe(z.number().int().min(1).max(MAX_SESSIONS).optional())
            .describe(
                `Number of sessions to summarize (1-${MAX_SESSIONS}, default ${DEFAULT_SESSIONS}). ` +
                `Pass as a number (e.g. 3); a quoted string ("3") is also accepted.`,
            ),
    }),
    execute: async (rawArgs, ctx) => {
        // Cast to the post-transform shape (TS still types as the input union).
        const { query, topSessions } = rawArgs as { query: string; topSessions?: number };
        const cfg = (ctx.configurable ?? {}) as Partial<SearchConversationHistoryConfigurable>;
        const { threadId, checkpointer, summaryModel } = cfg;

        if (!checkpointer) {
            return 'search_conversation_history: not configured (missing checkpointer).';
        }
        if (!summaryModel) {
            return 'search_conversation_history: no summary model available — configure an auxiliary model or provider.';
        }

        // No threadPrefix scoping; current thread excluded from grouping below.
        let hits: Awaited<ReturnType<CheckpointStore['searchMessagesByContent']>>;
        try {
            hits = await checkpointer.searchMessagesByContent<SearchableMessage>({
                query,
                limit: RAW_SEARCH_LIMIT,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `search_conversation_history: query failed: ${msg}`;
        }

        if (hits.length === 0) {
            return `No past conversations matching "${query}".`;
        }

        const seen = new Set<string>();
        const bundles: SessionBundle[] = [];
        const wantSessions = topSessions ?? DEFAULT_SESSIONS;

        for (const h of hits) {
            if (h.threadId === threadId) continue;
            if (seen.has(h.threadId)) continue;
            seen.add(h.threadId);

            const messages = await loadThreadMessages(checkpointer, h.threadId);
            if (messages.length === 0) continue;

            bundles.push({
                threadId: h.threadId,
                startedAt: extractStartedAt(messages),
                messages,
            });

            if (bundles.length >= wantSessions) break;
        }

        if (bundles.length === 0) {
            return `No past conversations matching "${query}" (all hits were in the current thread).`;
        }

        const summaries: string[] = [];
        for (const bundle of bundles) {
            try {
                const transcript = formatTranscript(bundle.messages);
                const summary = await summarizeSession(summaryModel, transcript, query, bundle);
                summaries.push(summary);
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                summaries.push(
                    `- **${bundle.startedAt}**: (summary failed: ${errMsg.slice(0, 80)})`,
                );
            }
        }

        const header = `${summaries.length} session${summaries.length === 1 ? '' : 's'} matching "${query}":`;
        return [header, '', ...summaries].join('\n');
    },
});

async function loadThreadMessages(
    checkpointer: CheckpointStore,
    threadId: string,
): Promise<SearchableMessage[]> {
    try {
        const msgs = await checkpointer.getThreadMessages<SearchableMessage>(threadId, {
            limit: MAX_MESSAGES_PER_SESSION,
        });
        // Keep only user/assistant turns for summarisation.
        return msgs.filter((m) => {
            const role = m?.role;
            return role === 'user' || role === 'assistant';
        });
    } catch {
        return [];
    }
}

function extractStartedAt(messages: SearchableMessage[]): string {
    // Best-effort: messages may lack createdAt (raw ChatMessage shape); fall back to today.
    const first = messages[0];
    const ts = first && typeof first.createdAt === 'number' ? first.createdAt : Date.now();
    return new Date(ts).toISOString().slice(0, 10);
}

function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
            if (block && typeof block === 'object' && 'text' in block) {
                const t = (block as { text?: unknown }).text;
                if (typeof t === 'string') parts.push(t);
            }
        }
        return parts.join(' ');
    }
    return '';
}

function formatTranscript(messages: SearchableMessage[]): string {
    const parts: string[] = [];
    for (const msg of messages) {
        const role = msg.role === 'user' ? 'USER' : 'ASSISTANT';
        const text = extractText(msg.content);
        const content = text.length > 2000
            ? text.slice(0, 1000) + '\n...[truncated]...\n' + text.slice(-1000)
            : text;
        if (content.length > 0) {
            parts.push(`[${role}]: ${content}`);
        }
    }
    const full = parts.join('\n\n');
    if (full.length > MAX_CHARS_PER_SESSION) {
        return full.slice(0, MAX_CHARS_PER_SESSION - 50) +
            '\n\n...[rest of conversation truncated]...';
    }
    return full;
}

async function summarizeSession(
    model: BaseChatModel,
    transcript: string,
    query: string,
    bundle: SessionBundle,
): Promise<string> {
    const systemPrompt =
        'You are reviewing a past conversation transcript to help an assistant recall context. ' +
        'Summarize the conversation with focus on the search topic. Include:\n' +
        '1. What the user asked about or wanted to accomplish\n' +
        '2. What actions were taken and what the outcomes were\n' +
        '3. Key decisions, solutions found, or conclusions reached\n' +
        '4. Any specific files, URLs, commands, or technical details that were important\n' +
        '5. Anything left unresolved or notable\n\n' +
        'Be thorough but concise. Write in past tense as a factual recap.';

    const userPrompt = [
        `Search topic: ${query}`,
        `Session date: ${bundle.startedAt}`,
        `Session ID: ${bundle.threadId}`,
        '',
        'CONVERSATION TRANSCRIPT:',
        transcript,
        '',
        `Summarize this conversation with focus on: ${query}`,
    ].join('\n');

    const response = await model.invoke(
        [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        { signal: AbortSignal.timeout(30_000) },
    );

    const content = typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
            ? response.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join('')
            : '';

    const summary = content.trim() || '(empty summary)';
    return `- **${bundle.startedAt}** (${bundle.threadId}): ${summary}`;
}
