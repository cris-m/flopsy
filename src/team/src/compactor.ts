import { createLogger } from '@flopsy/shared';
import type { BaseChatModel, ChatMessage, Interceptor } from 'flopsygraph';

const log = createLogger('compactor');

// Three thresholds (SpaceBot pattern). Hit any one → that tier's action.
// Defaults match SpaceBot's CompactionConfig: 80 / 85 / 95 percent.
const DEFAULT_BACKGROUND_THRESHOLD = 0.80;   // LLM summary, drop oldest 30%
const DEFAULT_AGGRESSIVE_THRESHOLD = 0.85;   // no LLM, drop oldest 50%
const DEFAULT_EMERGENCY_THRESHOLD  = 0.95;   // no LLM, hard truncate

// Conservative default. Most providers we use have 200k+, but Sonnet 4.6
// for example is 200k. The actual model's context window varies — wire
// the real value via config when the model is known.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

// Always preserve at least this many recent messages — the user's last
// utterance and the agent's in-flight reasoning would be lost otherwise.
const MIN_KEEP_RECENT = 6;

// Always preserve the system prompt and the first message (usually a
// scene-setter that anchors the conversation).
const MIN_KEEP_HEAD = 2;

const SUMMARY_PREFIX = '[CONTEXT COMPACTION — REFERENCE ONLY] ';
const TRUNCATE_MARKER_PREFIX = '[SYSTEM: ';

export interface CompactorOptions {
    /**
     * The model used for the summary call at the 80% tier. Skip the
     * tier entirely (auto-promote to aggressive drop) if not provided.
     */
    summaryModel?: BaseChatModel;

    /** Total token budget. Defaults to 128k. */
    contextWindowTokens?: number;

    /**
     * Override individual thresholds. Each is a fraction of context_window.
     * 0 < background < aggressive < emergency <= 1.
     */
    backgroundThreshold?: number;
    aggressiveThreshold?: number;
    emergencyThreshold?: number;

    /** Always keep this many oldest messages. Default: 2 (system + scene). */
    keepHead?: number;

    /** Always keep this many newest messages. Default: 6. */
    keepRecent?: number;
}

/** Token estimator (4 chars ≈ 1 token — same heuristic as flopsygraph). */
function estimateMessageTokens(msg: ChatMessage): number {
    const text =
        typeof msg.content === 'string'
            ? msg.content
            : msg.content.map((b) => ('text' in b ? b.text : '')).join('');
    return Math.ceil(text.length / 4);
}

function totalTokens(msgs: ChatMessage[]): number {
    let n = 0;
    for (const m of msgs) n += estimateMessageTokens(m);
    return n;
}

/**
 * Three-threshold programmatic compactor (SpaceBot pattern).
 *
 *   ratio = totalTokens / contextWindow
 *
 *   < 0.80                            → no-op
 *   ≥ 0.80, < 0.85   (background)     → LLM summarises oldest 30%, drops them
 *   ≥ 0.85, < 0.95   (aggressive)     → no LLM, drops oldest 50% with marker
 *   ≥ 0.95           (emergency)      → no LLM, hard-cut to head + recent +
 *                                       single truncation marker
 *
 * The 95% tier is a circuit breaker — if the LLM-summarizer is slow or
 * failing, the brute-force truncator fires anyway so the turn always
 * makes forward progress.
 *
 * Runs on `beforeModelCall` so the trimmed window is what the model sees.
 * The underlying state messages are NOT mutated — the interceptor only
 * substitutes the messages passed to this single LLM call.
 */
// Stop retrying the LLM summary tier after this many consecutive failures.
// Prevents burning API calls when the context is irrecoverably over-limit.
const MAX_BACKGROUND_CONSECUTIVE_FAILURES = 3;

export function compactor(opts: CompactorOptions = {}): Interceptor {
    const contextWindow = opts.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const bgThreshold = opts.backgroundThreshold ?? DEFAULT_BACKGROUND_THRESHOLD;
    const aggThreshold = opts.aggressiveThreshold ?? DEFAULT_AGGRESSIVE_THRESHOLD;
    const emThreshold = opts.emergencyThreshold ?? DEFAULT_EMERGENCY_THRESHOLD;
    const keepHead = Math.max(opts.keepHead ?? MIN_KEEP_HEAD, MIN_KEEP_HEAD);
    const keepRecent = Math.max(opts.keepRecent ?? MIN_KEEP_RECENT, MIN_KEEP_RECENT);
    const summaryModel = opts.summaryModel;

    // Per-instance circuit breaker: demotes background → aggressive after
    // MAX_BACKGROUND_CONSECUTIVE_FAILURES consecutive summary failures.
    let bgConsecutiveFailures = 0;

    return {
        name: 'compactor',

        async beforeModelCall(ctx) {
            const msgs = ctx.messages as ChatMessage[];
            const tokens = totalTokens(msgs);
            const ratio = tokens / contextWindow;

            if (ratio < bgThreshold) return;

            // Decide tier.
            let tier: 'background' | 'aggressive' | 'emergency';
            if (ratio >= emThreshold) tier = 'emergency';
            else if (ratio >= aggThreshold) tier = 'aggressive';
            else tier = 'background';

            // Carve the slice we're allowed to compact: everything between
            // keepHead and keepRecent. If there's nothing in the middle,
            // the message list is already at minimum — nothing to do.
            const middleStart = keepHead;
            const middleEnd = msgs.length - keepRecent;
            if (middleEnd <= middleStart) return;

            const head = msgs.slice(0, keepHead);
            const middle = msgs.slice(middleStart, middleEnd);
            const recent = msgs.slice(middleEnd);

            // Background tier demoted if: no summary model, OR circuit breaker tripped.
            const bgDemoted =
                tier === 'background' &&
                (!summaryModel || bgConsecutiveFailures >= MAX_BACKGROUND_CONSECUTIVE_FAILURES);
            const effectiveTier = bgDemoted ? 'aggressive' : tier;

            log.info(
                {
                    tier: effectiveTier,
                    ratio: ratio.toFixed(3),
                    tokens,
                    contextWindow,
                    middleCount: middle.length,
                    bgConsecutiveFailures,
                },
                'compactor firing',
            );

            if (effectiveTier === 'background' && summaryModel) {
                const result = await runBackgroundTier(summaryModel, head, middle, recent);
                // runBackgroundTier falls back to aggressive on error — detect that by
                // checking whether the returned message list omits a summary prefix.
                const hasSummary = result.messages.some(
                    m => typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX),
                );
                if (hasSummary) {
                    bgConsecutiveFailures = 0;
                } else {
                    bgConsecutiveFailures++;
                    log.warn({ bgConsecutiveFailures }, 'background compaction fell back — incrementing failure counter');
                }
                return result;
            }
            if (effectiveTier === 'aggressive') {
                return runAggressiveTier(head, middle, recent);
            }
            return runEmergencyTier(head, middle, recent);
        },
    };
}

async function runBackgroundTier(
    model: BaseChatModel,
    head: ChatMessage[],
    middle: ChatMessage[],
    recent: ChatMessage[],
): Promise<{ messages: ChatMessage[] }> {
    // Drop oldest 30% of the middle; summarise the dropped portion.
    const dropCount = Math.max(1, Math.floor(middle.length * 0.30));
    const toSummarize = middle.slice(0, dropCount);
    const keep = middle.slice(dropCount);

    let summaryText = '';
    try {
        const response = await model.invoke([
            {
                role: 'system',
                content:
                    'You are summarising the oldest portion of a conversation to free up context. ' +
                    'Preserve: factual claims by the user, decisions made, ongoing tasks, key entities, identifiers. ' +
                    'Drop: pleasantries, redundant restatements, the bodies of tool outputs (note that tool X was called and returned Y type of result, not the raw payload). ' +
                    'Output: terse bullet list, no preamble, no closing remark.',
            },
            ...toSummarize,
        ]);
        summaryText =
            typeof response.content === 'string'
                ? response.content
                : response.content
                      .filter((b) => b.type === 'text')
                      .map((b) => (b as { text: string }).text)
                      .join('');
    } catch (err) {
        log.warn({ err }, 'background-tier summarisation failed — falling back to aggressive');
        return runAggressiveTier(head, middle, recent);
    }

    const summaryMsg: ChatMessage = {
        role: 'system',
        content: `${SUMMARY_PREFIX}${dropCount} earlier messages compressed:\n${summaryText}`,
    };

    return { messages: [...head, summaryMsg, ...keep, ...recent] };
}

function runAggressiveTier(
    head: ChatMessage[],
    middle: ChatMessage[],
    recent: ChatMessage[],
): { messages: ChatMessage[] } {
    // Drop oldest 50% of the middle, no LLM call. Replace with a marker.
    const dropCount = Math.max(1, Math.floor(middle.length * 0.50));
    const dropped = middle.slice(0, dropCount);
    const keep = middle.slice(dropCount);

    const marker: ChatMessage = {
        role: 'system',
        content: `${TRUNCATE_MARKER_PREFIX}${dropped.length} earlier messages dropped (aggressive compaction).]`,
    };

    return { messages: [...head, marker, ...keep, ...recent] };
}

function runEmergencyTier(
    head: ChatMessage[],
    middle: ChatMessage[],
    recent: ChatMessage[],
): { messages: ChatMessage[] } {
    // Hard cut: drop the entire middle. This is the last-resort circuit
    // breaker — guarantees the model gets a turn-shaped prompt even when
    // everything else has failed.
    const marker: ChatMessage = {
        role: 'system',
        content: `${TRUNCATE_MARKER_PREFIX}${middle.length} earlier messages truncated (context window emergency).]`,
    };

    return { messages: [...head, marker, ...recent] };
}
