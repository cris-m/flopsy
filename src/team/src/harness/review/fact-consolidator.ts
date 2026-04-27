import { createLogger } from '@flopsy/shared';
import type { BaseChatModel } from 'flopsygraph';
import type { LearningStore, FactRow } from '../storage';

const log = createLogger('fact-consolidator');

const MIN_FACTS_TO_CONSOLIDATE = 5;
const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60_000; // 24h per user
const CONSOLIDATION_TIMEOUT_MS = 60_000;
// Abort if the model wants to drop more than half the facts — signals a bad response.
const MAX_DROP_RATIO = 0.5;

const CONSOLIDATOR_SYSTEM = `You are a fact deduplicator for a user preference database.
Each fact has a predicate (the attribute name) and an object (the value).
Your task:
1. Merge semantically equivalent facts into one: keep the most specific/recent.
2. Remove exact duplicates.
3. Resolve conflicts on the same predicate: keep the most informative value.
4. NEVER invent new predicates — only use predicates from the input.
5. Return ONLY valid JSON matching the schema: {"consolidated":[{"predicate":"...","object":"..."}]}
No explanation, no markdown, just the JSON object.`;

interface ConsolidatedFact {
    predicate: string;
    object: string;
}

interface ConsolidateResponse {
    consolidated: ConsolidatedFact[];
}

export interface FactConsolidatorConfig {
    readonly model: BaseChatModel;
    readonly store: LearningStore;
}

/**
 * FactConsolidator — periodic deduplication of user preference facts.
 *
 * Runs at most once per 24 hours per userId. Loads all current facts for
 * that user, asks the model to merge semantically equivalent ones, then
 * applies the diff: retires removed facts, updates changed values.
 *
 * Gated on a `consolidation:ran_at` marker fact so the interval is
 * persisted across restarts without a schema migration.
 */
export class FactConsolidator {
    constructor(private readonly config: FactConsolidatorConfig) {}

    /**
     * Call once per user turn or on a cron-style schedule.
     * Skips silently if the 24h window hasn't elapsed.
     * Never throws — safe to call fire-and-forget.
     */
    async maybeConsolidate(userId: string): Promise<void> {
        if (!this.isEligible(userId)) return;
        try {
            await this.runConsolidation(userId);
        } catch (err) {
            log.warn({ err, userId }, 'fact consolidation failed');
        }
    }

    private isEligible(userId: string): boolean {
        const markers = this.config.store.getCurrentFacts(userId, 'consolidation');
        const last = markers.find((f) => f.predicate === 'ran_at');
        if (!last) return true;
        return Date.now() - last.validityStart >= CONSOLIDATION_INTERVAL_MS;
    }

    private async runConsolidation(userId: string): Promise<void> {
        const facts = this.config.store.getCurrentFacts(userId, 'user');
        if (facts.length < MIN_FACTS_TO_CONSOLIDATE) {
            log.debug({ userId, count: facts.length }, 'too few facts — skipping consolidation');
            return;
        }

        const prompt = buildConsolidationPrompt(facts);

        const signal = AbortSignal.timeout(CONSOLIDATION_TIMEOUT_MS);
        const response = await this.config.model.invoke(
            [
                { role: 'system', content: CONSOLIDATOR_SYSTEM },
                { role: 'user', content: prompt },
            ],
            { signal },
        );

        const rawText =
            typeof response.content === 'string'
                ? response.content.trim()
                : response.content
                      .filter((b) => b.type === 'text')
                      .map((b) => (b as { text: string }).text)
                      .join('')
                      .trim();

        const parsed = parseConsolidateResponse(rawText);
        if (!parsed) {
            log.warn({ userId }, 'fact consolidator: failed to parse model response');
            return;
        }

        // Safety: abort if model dropped too many facts (likely a bad response).
        const dropRatio = 1 - parsed.consolidated.length / facts.length;
        if (dropRatio > MAX_DROP_RATIO) {
            log.warn(
                { userId, original: facts.length, proposed: parsed.consolidated.length },
                'fact consolidator: model dropped too many facts — aborting',
            );
            return;
        }

        // Only allow predicates that existed in the input.
        const knownPredicates = new Set(facts.map((f) => f.predicate));
        const safe = parsed.consolidated.filter((c) => knownPredicates.has(c.predicate));
        if (safe.length < parsed.consolidated.length) {
            log.warn(
                { userId, hallucinated: parsed.consolidated.length - safe.length },
                'fact consolidator: model hallucinated new predicates — filtered out',
            );
        }

        applyConsolidation(userId, facts, safe, this.config.store);

        this.config.store.recordFact({
            userId,
            subject: 'consolidation',
            predicate: 'ran_at',
            object: String(Date.now()),
            validityStart: Date.now(),
            validityEnd: null,
            confidence: 1.0,
            source: 'fact-consolidator',
        });

        log.info(
            { userId, before: facts.length, after: safe.length },
            'fact consolidation complete',
        );
    }
}

function buildConsolidationPrompt(facts: FactRow[]): string {
    const lines = facts.map((f) => `- predicate="${f.predicate}" object="${f.object}"`).join('\n');
    return `User preference facts to consolidate (${facts.length} total):\n\n${lines}\n\nReturn the consolidated list.`;
}

function parseConsolidateResponse(raw: string): ConsolidateResponse | null {
    try {
        // Strip markdown fences if present.
        const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(clean) as unknown;
        if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'consolidated' in parsed &&
            Array.isArray((parsed as ConsolidateResponse).consolidated)
        ) {
            return parsed as ConsolidateResponse;
        }
        return null;
    } catch {
        return null;
    }
}

function applyConsolidation(
    userId: string,
    current: FactRow[],
    desired: ConsolidatedFact[],
    store: LearningStore,
): void {
    const now = Date.now();
    const desiredMap = new Map(desired.map((d) => [d.predicate, d.object]));
    const currentMap = new Map(current.map((f) => [f.predicate, f]));

    let updated = 0;
    let retired = 0;

    for (const [predicate, fact] of currentMap) {
        const desiredObject = desiredMap.get(predicate);

        if (desiredObject === undefined) {
            // Model decided to retire this fact (merged into another).
            store.retireFact(fact.id, now);
            retired++;
        } else if (desiredObject !== fact.object) {
            // Model updated the value — recordFact tombstones the old one.
            store.recordFact({
                userId,
                subject: 'user',
                predicate,
                object: desiredObject,
                validityStart: now,
                validityEnd: null,
                confidence: fact.confidence,
                source: 'fact-consolidator',
            });
            updated++;
        }
        // desiredObject === fact.object → no change needed.
    }

    if (updated > 0 || retired > 0) {
        log.debug({ userId, updated, retired }, 'fact consolidation diff applied');
    }
}
