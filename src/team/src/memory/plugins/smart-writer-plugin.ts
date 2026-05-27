import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { createLogger } from '@flopsy/shared';
import {
    defineTool,
    NvidiaChatModel,
    OllamaChatModel,
    SqliteMemoryProvider,
    type BaseChatModel,
    type BaseTool,
    type ChatMessage,
    type Embedder,
    type Interceptor,
} from 'flopsygraph';

const log = createLogger('memory-smart-writer-plugin');

export interface MemorySmartWriterPluginOptions {
    model: string;
    embedder: Embedder;
    dbPath: string;
    similarityThreshold: number;
    topK: number;
    auditLog: string;
    apiKey?: string;
    modelInstance?: BaseChatModel;
}

const DECISION_ENUM = ['ADD', 'UPDATE', 'DELETE', 'NOOP'] as const;
type Decision = (typeof DECISION_ENUM)[number];

interface SmartWriteAuditEntry {
    ts: number;
    target: 'user' | 'memory';
    newContent: string;
    candidatesSimilarities: number[];
    decision: Decision;
    targetIndex?: number;
    targetExistingContent?: string;
    mergedContent?: string;
    reason: string;
    elapsedMs: number;
    actionApplied: 'add' | 'replace' | 'remove' | 'noop';
}

const SmartRememberSchema = z.object({
    content: z
        .string()
        .min(2)
        .max(2000)
        .describe(
            'The fact, preference, or observation to remember. Free-form text. ' +
                'Examples: "User uses qwen-coder for code review", "Bytepesa migrated to Postgres 17 on 2026-05-25".',
        ),
    target: z
        .enum(['user', 'memory'])
        .describe(
            '`user` = stable USER.md facts (name, location, durable preferences). ' +
                '`memory` = MEMORY.md project state, decisions, environment, lessons. ' +
                'Pick `user` only when the fact would still be true a year from now in any context.',
        ),
});

const SMART_REMEMBER_DESCRIPTION = `LLM-mediated memory write. Use this INSTEAD of the raw \`memory({action:"add", ...})\` tool when you are NOT 100% sure if the fact is genuinely new or already captured under a different wording. This plugin decides among four operations and applies the right one:

  ADD     — the fact is genuinely new; appended as a new entry
  UPDATE  — the fact REFINES or SUPERSEDES an existing entry; replaces it (e.g. "Location: Berlin" → "Location: Tokyo")
  DELETE  — the fact MAKES an existing entry obsolete; removes it (e.g. user explicitly retracts a preference)
  NOOP    — the fact is already captured in essence under another wording; nothing written

DECISION PROCESS
  1. Embed your content using the configured embedder
  2. Find top-K most similar existing entries in this target's namespace
  3. If no candidate exceeds the similarity threshold → ADD directly (no LLM call, fast path)
  4. Otherwise, call the configured decision LLM (currently a NIM gemma model) with the new content + candidates
  5. The LLM picks ONE of {ADD, UPDATE, DELETE, NOOP} and apply it

WHEN TO USE
  • You learned something that MIGHT already be in memory under different wording. "User likes jokes" / "User enjoys comedy" — both true; only one should live.
  • You're updating a fact you SUSPECT is stored but don't know the exact phrasing. "User moved from Berlin to Tokyo" — finds and replaces.
  • You want to avoid clogging USER.md/MEMORY.md with near-duplicates.

WHEN NOT TO USE
  • You're SURE the fact is brand new → use \`memory({action:"add", ...})\` directly (skips LLM cost)
  • You have the EXACT old_text → use \`memory({action:"replace", old_text:"...", content:"..."})\` directly
  • The content is structured (Key:Value) and you know the key → use \`memory({action:"upsert", key:"...", content:"..."})\` directly

RETURNS
  JSON: { decision: "ADD"|"UPDATE"|"DELETE"|"NOOP", reason, action_applied, target_index?, merged_content? }
  Read \`reason\` to understand WHY the LLM picked that action. Audit log appended to ${'\`auditLog\`'} regardless of decision.

COST: one embedder call + one search + (when similar entries exist) one LLM call. Cheap LLM (NIM gemma) — typically 300-800ms total. Skip this tool when you're sure of your action to save the cost.`;

export function createMemorySmartWriterPlugin(opts: MemorySmartWriterPluginOptions): Interceptor {
    const store = new SqliteMemoryProvider(opts.dbPath, {
        embedder: opts.embedder,
        name: 'smart-writer-index',
    });

    const buildModel = (): BaseChatModel => {
        const idx = opts.model.indexOf(':');
        if (idx <= 0) throw new Error(`smart-writer: bad model id "${opts.model}" — expected "provider:name"`);
        const provider = opts.model.slice(0, idx);
        const name = opts.model.slice(idx + 1);
        if (provider === 'nvidia') {
            if (!opts.apiKey) throw new Error('smart-writer: NVIDIA_API_KEY required for nvidia: model');
            return new NvidiaChatModel(name, { temperature: 0 }, opts.apiKey);
        }
        if (provider === 'ollama') {
            return new OllamaChatModel(name, { temperature: 0 }, undefined, 'http://localhost:11434/v1');
        }
        throw new Error(`smart-writer: unknown provider "${provider}"`);
    };

    let cachedModel: BaseChatModel | null = opts.modelInstance ?? null;
    const getModel = (): BaseChatModel => {
        if (!cachedModel) cachedModel = buildModel();
        return cachedModel;
    };

    const appendAudit = async (entry: SmartWriteAuditEntry): Promise<void> => {
        try {
            if (!existsSync(dirname(opts.auditLog))) {
                await mkdir(dirname(opts.auditLog), { recursive: true });
            }
            await appendFile(opts.auditLog, JSON.stringify(entry) + '\n', 'utf8');
        } catch (err) {
            log.debug({ err, auditLog: opts.auditLog }, 'smart-write audit append failed (continuing)');
        }
    };

    const decisionPrompt = (newContent: string, candidates: ReadonlyArray<{ content: string; idx: number; similarity: number }>): ChatMessage[] => {
        const candidateLines = candidates
            .map((c, i) => `[${i}] (sim ${(c.similarity * 100).toFixed(0)}%) "${c.content}"`)
            .join('\n');
        const system: ChatMessage = {
            role: 'system',
            content:
                'You decide what to do with a new memory entry given similar existing entries. ' +
                'Reply with STRICT JSON of shape: ' +
                '{"decision":"ADD"|"UPDATE"|"DELETE"|"NOOP","target_idx":number|null,"merged":string|null,"reason":string}. ' +
                'Rules: UPDATE replaces an existing entry with refined content (set target_idx + merged). ' +
                'DELETE removes one (set target_idx; merged null). ' +
                'NOOP if the new content adds no information beyond an existing entry. ' +
                'ADD if the new content is genuinely new. Keep reasoning to one short sentence in "reason".',
        };
        const user: ChatMessage = {
            role: 'user',
            content:
                `NEW CONTENT:\n${newContent}\n\nEXISTING SIMILAR ENTRIES:\n${candidateLines}\n\nDecide and reply with the JSON.`,
        };
        return [system, user];
    };

    const decisionSchema = z.object({
        decision: z.enum(DECISION_ENUM),
        target_idx: z.number().int().min(0).nullable(),
        merged: z.string().nullable(),
        reason: z.string().min(3).max(300),
    });

    const callDecisionLLM = async (
        newContent: string,
        candidates: ReadonlyArray<{ content: string; idx: number; similarity: number }>,
    ): Promise<z.infer<typeof decisionSchema>> => {
        const messages = decisionPrompt(newContent, candidates);
        const response = await getModel().invoke(messages);
        const raw = typeof response.content === 'string'
            ? response.content
            : Array.isArray(response.content)
                ? response.content.map((b) => ('text' in b ? (b as { text: string }).text : '')).join('')
                : '';
        const parsed = JSON.parse(raw);
        return decisionSchema.parse(parsed);
    };

    const smartRememberTool: BaseTool = defineTool({
        name: 'smart_remember',
        description: SMART_REMEMBER_DESCRIPTION,
        schema: SmartRememberSchema,
        execute: async (args) => {
            const t0 = Date.now();
            const newContent = args.content.trim();
            const target = args.target;

            try {
                const candidates = await store.search({
                    query: newContent,
                    namespace: target,
                    limit: opts.topK,
                });
                const ranked = candidates
                    .filter((c) => (c.score ?? 0) >= opts.similarityThreshold)
                    .map((c, i) => ({
                        content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
                        idx: i,
                        similarity: c.score ?? 0,
                    }));

                let decision: Decision;
                let targetIdx: number | null = null;
                let merged: string | null = null;
                let reason: string;

                if (ranked.length === 0) {
                    decision = 'ADD';
                    reason = `no existing entry above similarity ${opts.similarityThreshold}; treating as new`;
                } else {
                    const llm = await callDecisionLLM(newContent, ranked);
                    decision = llm.decision;
                    targetIdx = llm.target_idx;
                    merged = llm.merged;
                    reason = llm.reason;
                }

                let actionApplied: SmartWriteAuditEntry['actionApplied'] = 'noop';
                let targetExisting: string | undefined;

                if (decision === 'ADD') {
                    await store.add({ namespace: target, content: newContent });
                    actionApplied = 'add';
                } else if (decision === 'UPDATE' && targetIdx !== null && ranked[targetIdx] && merged) {
                    targetExisting = ranked[targetIdx]!.content;
                    await store.replace({
                        namespace: target,
                        target: targetExisting,
                        content: merged,
                    });
                    actionApplied = 'replace';
                } else if (decision === 'DELETE' && targetIdx !== null && ranked[targetIdx]) {
                    targetExisting = ranked[targetIdx]!.content;
                    await store.remove({ namespace: target, target: targetExisting });
                    actionApplied = 'remove';
                }

                const auditEntry: SmartWriteAuditEntry = {
                    ts: Date.now(),
                    target,
                    newContent,
                    candidatesSimilarities: ranked.map((c) => c.similarity),
                    decision,
                    ...(targetIdx !== null ? { targetIndex: targetIdx } : {}),
                    ...(targetExisting !== undefined ? { targetExistingContent: targetExisting } : {}),
                    ...(merged ? { mergedContent: merged } : {}),
                    reason,
                    elapsedMs: Date.now() - t0,
                    actionApplied,
                };
                await appendAudit(auditEntry);

                return JSON.stringify({
                    decision,
                    action_applied: actionApplied,
                    target_index: targetIdx,
                    merged_content: merged,
                    reason,
                    elapsed_ms: auditEntry.elapsedMs,
                    candidates_considered: ranked.length,
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn({ err: msg, target }, 'smart_remember failed — falling back to plain add');
                try { await store.add({ namespace: target, content: newContent }); }
                catch { /* */ }
                return JSON.stringify({
                    decision: 'ADD',
                    action_applied: 'add',
                    target_index: null,
                    merged_content: null,
                    reason: `LLM decision failed (${msg.slice(0, 120)}); fell back to plain add`,
                    elapsed_ms: Date.now() - t0,
                    error: true,
                });
            }
        },
    });

    return {
        name: 'memory-smart-writer',
        priority: 40,
        tools: [smartRememberTool],

        async onMemoryWrite(action, target, content) {
            if (action === 'add' || action === 'upsert' || action === 'replace' || action === 'patch' || action === 'move') {
                try { await store.add({ namespace: target, content }); }
                catch (err) { log.debug({ err, action, target }, 'smart-writer index mirror failed'); }
            } else if (action === 'remove') {
                try { await store.remove({ namespace: target, target: content }); }
                catch { /* */ }
            }
        },
    };
}

export type { SmartWriteAuditEntry };
