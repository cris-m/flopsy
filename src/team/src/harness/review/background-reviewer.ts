import { createLogger } from '@flopsy/shared';
import type { BaseChatModel } from 'flopsygraph';
import type { LearningStore } from '../storage';
import { REVIEWER_SYSTEM, buildReviewPrompt, parseReviewResponse } from './prompts';
import type { ReviewFact } from './prompts';
import { writeSkillFile } from './skill-writer';
import { getScheduleFacade } from '../../tools/schedule-registry';

const log = createLogger('background-reviewer');

const DEFAULT_INTERVAL_TURNS = 5;
// Keep the snapshot small — enough context to spot patterns, cheap to send.
const SNAPSHOT_MESSAGE_LIMIT = 20;
// Hard cap on the background LLM call — prevents a slow provider from
// accumulating in-flight reviews that queue up and eat memory.
const REVIEW_TIMEOUT_MS = 5 * 60_000;

export interface BackgroundReviewerConfig {
    readonly model: BaseChatModel;
    readonly store: LearningStore;
    readonly skillsPath: string;
    /** Fire a review every N completed agent turns. Default: 5. */
    readonly intervalTurns?: number;
}

/**
 * BackgroundReviewer — Hermes-style autonomous skill extractor.
 *
 * After every `intervalTurns` completed agent turns it:
 *   1. Fetches the last N messages for the thread from LearningStore.
 *   2. Calls the model with a tight structured prompt.
 *   3. If the model decides a reusable procedure is worth capturing,
 *      writes a new SKILL.md to the workspace skills directory.
 *
 * The review runs as a fire-and-forget async task — it never blocks the
 * agent turn that triggered it and its failure is logged, not thrown.
 */
export class BackgroundReviewer {
    private readonly model: BaseChatModel;
    private readonly store: LearningStore;
    private readonly skillsPath: string;
    private readonly intervalTurns: number;

    constructor(config: BackgroundReviewerConfig) {
        this.model = config.model;
        this.store = config.store;
        this.skillsPath = config.skillsPath;
        this.intervalTurns = config.intervalTurns ?? DEFAULT_INTERVAL_TURNS;
    }

    /**
     * Call at the end of each completed agent turn.
     * Fire-and-forget — the promise is voided intentionally.
     */
    maybeTrigger(userId: string, threadId: string, completedTurns: number): void {
        if (completedTurns % this.intervalTurns !== 0) return;
        log.debug(
            { userId, threadId, completedTurns, interval: this.intervalTurns },
            'background review triggered',
        );
        void this.runReview(userId, threadId).catch((err: unknown) => {
            log.warn({ err, userId, threadId }, 'background review failed');
        });
    }

    private maybeProposeDomainSchedules(userId: string, newFacts: ReviewFact[]): void {
        const interestFacts = newFacts.filter((f) => f.predicate === 'domain_interest');
        if (interestFacts.length === 0) return;

        const facade = getScheduleFacade();
        if (!facade) return;

        let scheduleNames: Set<string>;
        try {
            scheduleNames = new Set(
                facade.listSchedules().flatMap((s) => {
                    try {
                        const cfg = JSON.parse(s.configJson) as { name?: string };
                        return cfg.name ? [cfg.name.toLowerCase()] : [];
                    } catch { return []; }
                }),
            );
        } catch {
            return;
        }

        const now = Date.now();
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;
        const recentProposals = new Set(
            this.store
                .getCurrentFacts(userId, 'interest-proposal')
                .filter((f) => f.validityStart > now - sevenDaysMs)
                .map((f) => f.object.toLowerCase()),
        );

        for (const fact of interestFacts) {
            const key = fact.object.toLowerCase();
            const alreadyScheduled = [...scheduleNames].some((n) => n.includes(key));
            if (alreadyScheduled || recentProposals.has(key)) continue;

            this.store.recordFact({
                userId,
                subject: 'interest-proposal',
                predicate: 'pending',
                object: fact.object,
                validityStart: now,
                validityEnd: null,
                confidence: 1.0,
                source: 'background-reviewer',
            });
            log.info({ userId, interest: fact.object }, 'interest-schedule proposal queued');
        }
    }

    private async runReview(userId: string, threadId: string): Promise<void> {
        const messages = this.store.getThreadMessages(threadId, SNAPSHOT_MESSAGE_LIMIT);

        // Need at least a few exchanges to have something worth reviewing.
        if (messages.length < 3) {
            log.debug({ threadId, count: messages.length }, 'too few messages — skipping review');
            return;
        }

        const userPrompt = buildReviewPrompt(messages);

        const signal = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
        const response = await this.model.invoke(
            [
                { role: 'system', content: REVIEWER_SYSTEM },
                { role: 'user', content: userPrompt },
            ],
            { signal },
        );

        const rawText =
            typeof response.content === 'string'
                ? response.content
                : response.content
                      .filter((b) => b.type === 'text')
                      .map((b) => (b as { text: string }).text)
                      .join('');

        const decision = parseReviewResponse(rawText);

        // Layer 3 — persist user preference facts.
        if (decision.facts.length > 0) {
            const now = Date.now();
            for (const fact of decision.facts) {
                this.store.recordFact({
                    userId,
                    subject: 'user',
                    predicate: fact.predicate,
                    object: fact.object,
                    validityStart: now,
                    validityEnd: null,
                    confidence: 0.7,
                    source: 'background-review',
                });
            }
            log.info({ userId, threadId, count: decision.facts.length }, 'user facts recorded');
            this.maybeProposeDomainSchedules(userId, decision.facts);
        }

        if (!decision.shouldWrite || !decision.skillName || !decision.skillContent) {
            log.debug({ threadId }, 'reviewer decided no skill worth capturing');
            return;
        }

        const written = await writeSkillFile(
            this.skillsPath,
            decision.skillName,
            decision.skillContent,
        );

        if (written) {
            log.info(
                { userId, threadId, skill: decision.skillName },
                'background reviewer wrote new skill',
            );
        }
    }
}
