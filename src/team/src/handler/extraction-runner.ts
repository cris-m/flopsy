import { createLogger, workspace } from '@flopsy/shared';
import { emitHookAwait } from '@flopsy/gateway';
import type { CheckpointStore, MemoryProvider } from 'flopsygraph';
import { parseMemoryConfig } from '../memory';
import {
    appendLessonsToSkill,
    drainSkillProposals,
    runSkillCurator,
    validatePendingEdits,
    scanExistingSkills,
    SessionExtractor,
    SkillUsageStore,
    writeSkillFile,
    type ExtractionResult,
    type SkillProposal,
} from '../harness/review';
import { getSharedLearningStore } from '../harness';
import type { LearningStore } from '../harness';
import { redactSecrets } from './redact';

const log = createLogger('extraction-runner');

const AUTO_PROMOTE_CONFIDENCE = 0.8;

export interface ExtractionRunnerDeps {
    readonly sessionExtractor?: SessionExtractor;
    readonly store: LearningStore;
    readonly memoryConfig: unknown;
    readonly getMemoryProvider: () => Promise<MemoryProvider | undefined>;
    readonly checkpointer: CheckpointStore;
}

export interface ExtractionRunnerArgs {
    readonly closedThreadId: string;
    readonly closedSessionId: string;
    readonly peerId: string;
}

// Best-effort throughout: any step's failure logs warn + continues so partial extraction survives.
export async function runSessionExtraction(
    args: ExtractionRunnerArgs,
    deps: ExtractionRunnerDeps,
): Promise<ExtractionResult | null> {
    const { closedThreadId, closedSessionId, peerId } = args;
    if (!deps.sessionExtractor) return null;

    const skillsPath = workspace.skills();
    const existingSkills = scanExistingSkills(skillsPath);

    const result = await deps.sessionExtractor.extract(closedThreadId, peerId, existingSkills);
    if (!result) return null;

    const usageStore = new SkillUsageStore(skillsPath);

    try {
        deps.store.setSessionSummary(closedSessionId, result.summary);

        if (result.memory_facts.length > 0) {
            const hookResult = await emitHookAwait('memory.fact.ingested', {
                peerId,
                factCount: result.memory_facts.length,
            });
            if (hookResult.blocked) {
                log.info(
                    {
                        peerId,
                        hookId: hookResult.blocked.hookId,
                        message: hookResult.blocked.message,
                    },
                    'memory ingest blocked by hook',
                );
            } else {
                try {
                    const provider = await deps.getMemoryProvider();
                    if (provider?.ingest) {
                        await provider.ingest(
                            { kind: 'facts', facts: result.memory_facts },
                            {},
                        );
                    }
                } catch (err) {
                    log.warn(
                        {
                            err: redactSecrets(err),
                            peerId,
                            factCount: result.memory_facts.length,
                        },
                        'memory ingest from session extraction failed (non-fatal)',
                    );
                }
            }
        }

        let proposedSkillName: string | null = null;
        let promotedSkillName: string | null = null;
        if (result.skill_proposal) {
            const proposed = result.skill_proposal;
            const autoPromote = proposed.confidence >= AUTO_PROMOTE_CONFIDENCE;
            const hookResult = await emitHookAwait('skill.proposed', {
                peerId,
                skillName: proposed.name,
                confidence: proposed.confidence,
                autoPromote,
            });
            if (hookResult.blocked) {
                log.info(
                    {
                        peerId,
                        skillName: proposed.name,
                        hookId: hookResult.blocked.hookId,
                        message: hookResult.blocked.message,
                    },
                    'skill proposal blocked by hook',
                );
            } else {
                const destRoot = autoPromote ? skillsPath : workspace.skillsProposed();
                try {
                    const written = await writeSkillFile(
                        destRoot,
                        proposed.name,
                        renderProposedSkillBody(proposed),
                    );
                    if (written) {
                        usageStore.markAgentCreated(proposed.name);
                        if (autoPromote) promotedSkillName = proposed.name;
                        else proposedSkillName = proposed.name;
                    }
                } catch (err) {
                    log.warn(
                        { err: (err as Error).message, name: proposed.name, peerId },
                        'skill proposal write failed',
                    );
                }
            }
        }

        const skillsImproved: string[] = [];
        if (result.skill_lessons.length > 0) {
            for (const entry of result.skill_lessons) {
                try {
                    const ok = await appendLessonsToSkill(skillsPath, entry.name, entry.lessons);
                    if (ok) {
                        skillsImproved.push(entry.name);
                        usageStore.patch(entry.name);
                    }
                } catch (err) {
                    log.warn(
                        { err: (err as Error).message, skill: entry.name, peerId },
                        'append lessons failed',
                    );
                }
            }
        }

        try {
            const curated = runSkillCurator(skillsPath, usageStore);
            if (curated.markedStale.length > 0 || curated.markedArchived.length > 0) {
                log.info(
                    { markedStale: curated.markedStale, markedArchived: curated.markedArchived },
                    'skill curator swept',
                );
            }
            const validated = await validatePendingEdits(skillsPath, usageStore, getSharedLearningStore());
            if (validated.accepted.length > 0 || validated.rejected.length > 0) {
                log.info(
                    { accepted: validated.accepted, rejected: validated.rejected },
                    'skill-edit validation swept',
                );
            }
        } catch (err) {
            log.debug({ err: (err as Error).message }, 'skill curator failed (non-fatal)');
        }

        log.info(
            {
                peerId,
                closedSessionId,
                summaryChars: result.summary.length,
                skillProposed: proposedSkillName,
                skillPromoted: promotedSkillName,
                skillsImproved,
            },
            'session extraction persisted',
        );
    } catch (err) {
        log.warn(
            { err: redactSecrets(err), peerId, closedSessionId },
            'session extraction persisted partially or failed',
        );
    }

    try {
        const memCfg = parseMemoryConfig((deps.memoryConfig ?? {}) as Record<string, unknown>);
        if (memCfg.plugins.skillSignals.enabled) {
            const drained = await drainSkillProposals({
                proposalsPath: memCfg.plugins.skillSignals.proposalsPath,
                skillsPath: workspace.skills(),
                skillsProposedPath: workspace.skillsProposed(),
                minConfidence: memCfg.plugins.skillSignals.minConfidence,
            });
            if (drained.created.length || drained.appended.length || drained.archived > 0) {
                log.info(
                    {
                        peerId,
                        closedSessionId,
                        created: drained.created,
                        appended: drained.appended,
                        archived: drained.archived,
                        skipped: drained.skipped,
                    },
                    'drained skill-signal proposals',
                );
            }
        }
    } catch (err) {
        log.warn(
            { err: redactSecrets(err), peerId, closedSessionId },
            'skill-signal drainer failed (non-fatal)',
        );
    }

    // 24h retention matches proactive reaper default.
    const sweepable = deps.checkpointer as {
        pruneByThreadPrefix?: (prefix: string, olderThanMs: number) => Promise<number>;
    };
    if (typeof sweepable.pruneByThreadPrefix === 'function') {
        const fullThreadId = `${peerId}#${closedSessionId}`;
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        try {
            const deleted = await sweepable.pruneByThreadPrefix(
                `${fullThreadId}:worker:`,
                ONE_DAY_MS,
            );
            if (deleted > 0) {
                log.debug(
                    { closedThreadId: fullThreadId, deleted },
                    'pruned stale worker checkpoints for closed session',
                );
            }
        } catch (err) {
            log.debug(
                { err: (err as Error).message, peerId, closedSessionId },
                'worker checkpoint prune failed (non-fatal)',
            );
        }
    }

    return result;
}

// Frontmatter `name` MUST match the directory name or skills() silently drops it.
function renderProposedSkillBody(p: SkillProposal): string {
    const cleanBody = p.body.replace(/^---[\s\S]*?\n---\n?/, '').trim();
    const today = new Date().toISOString().slice(0, 10);
    return [
        '---',
        `name: ${p.name}`,
        `category: ${p.category}`,
        `description: ${p.description.replace(/\n/g, ' ').trim()}`,
        `when-to-use: ${p.when_to_use.replace(/\n/g, ' ').trim()}`,
        'source: extractor',
        `proposed-on: ${today}`,
        '---',
        '',
        cleanBody,
        '',
    ].join('\n');
}
