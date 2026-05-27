import { createLogger, channelCapabilityHint } from '@flopsy/shared';
import { detectPromptInjection, hasUnicodeContamination } from 'flopsygraph';
import type { ChannelRouter } from '../delivery/router';
import type { StateStore } from '../state/store';
import { getDefaultJobState, STALE_LOCK_MS } from '../state/store';
import type { PresenceManager } from '../state/presence';
import type { RetryQueue } from '../state/retry-queue';
import type {
    ExecutionJob,
    ExecutionResult,
    ConditionalResponse,
    AgentCaller,
    ThreadCleaner,
    ProactiveDecision,
    ReportedIds,
} from '../types';
import { BACKOFF_SCHEDULE_MS } from '../types';
import type { ProactiveDedupStore } from '../state/dedup-store';
import type { ProactiveEmbedder } from '../engine';
import { getSharedLearningStore } from '@flopsy/team';
import {
    parseReportedLines,
    stripReportedLines,
} from './context';
import { runScript } from './script-runner';
import { loadSkills } from './skill-loader';
import { emitHook } from '../../hooks';

/** Per-call context for recording `proactive_decisions` rows. */
interface DecisionContext {
    structured?: ProactiveOutput | undefined;
    deliveryText?: string;
}

// Conversation-role tags. A proactive fire is entirely first-party (operator
// prompt + curated skills + the agent's own recycled context), so one of these
// appearing in that content is never an injection attack — but the scanner's
// `fake-conversation-tag` rule would match and suppress every fire. We neutralize
// them to inert brackets before scanning so legit content can't trip the gate,
// while real injection patterns (ignore-previous, etc.) are still caught.
const ROLE_TAG_RE = /<\s*(\/?)\s*(system|tool_result|tool_use|assistant|human|user)\s*>/i;
const ROLE_TAG_RE_G = new RegExp(ROLE_TAG_RE.source, 'gi');
function neutralizeRoleTags(s: string): string {
    return s.replace(ROLE_TAG_RE_G, '[$1$2]');
}

/** Build a `<fire_context>` block with current date/time/timezone. */
function buildDateContext(): string {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const date = now.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz,
    });
    const time = now.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
    });
    return `<fire_context>\ndate: ${date}\ntime: ${time}\ntimezone: ${tz}\n</fire_context>\n\n`;
}

function fmtAgoMins(tsMs: number, now: number): string {
    const mins = Math.max(0, Math.floor((now - tsMs) / 60000));
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function clip(text: string, max: number): string {
    const t = (text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function buildAntiRepetition(store: StateStore): string {
    const now = Date.now();
    const deliveries = store.getRecentDeliveries().slice(0, 5);
    const suppressions = (store.getRecentSuppressions() ?? []).slice(0, 5);
    if (deliveries.length === 0 && suppressions.length === 0) return '';
    const lines = [
        '<anti_repetition>',
        'You have already delivered or considered+rejected the following recently. Use this to decide whether THIS fire adds new value — not to mechanically suppress.',
    ];
    if (deliveries.length > 0) {
        lines.push('', 'Recently delivered:');
        for (const d of deliveries) {
            lines.push(`  - ${fmtAgoMins((d as { deliveredAt?: number }).deliveredAt ?? now, now)} [${(d as { source?: string }).source ?? '?'}]: ${clip((d as { content?: string }).content ?? '', 120)}`);
        }
    }
    if (suppressions.length > 0) {
        lines.push('', 'Recently considered + suppressed (don\'t re-propose the same item):');
        for (const s of suppressions) {
            const reason = (s as { reason?: string }).reason;
            lines.push(`  - ${fmtAgoMins((s as { suppressedAt?: number }).suppressedAt ?? now, now)} [${(s as { source?: string }).source ?? '?'}${reason ? ` · ${reason}` : ''}]: ${clip((s as { content?: string }).content ?? '', 120)}`);
        }
    }
    lines.push('</anti_repetition>');
    return lines.join('\n') + '\n\n';
}

function buildToolQuirks(peerId: string | undefined): string {
    if (!peerId) return '';
    try {
        const quirks = getSharedLearningStore().listRecentToolFailures(peerId, { limit: 5, windowMs: 7 * 24 * 60 * 60 * 1000 });
        if (quirks.length === 0) return '';
        const lines = [
            '<tool_quirks>',
            'Tools that have been failing recently for this peer. Before calling one of these, consider whether a different approach works — if you call it anyway and it fails the same way, do not retry blindly; pivot or surface the obstacle.',
        ];
        for (const q of quirks) {
            const ageH = Math.max(1, Math.round((Date.now() - q.lastSeen) / 3_600_000));
            lines.push(`  - ${q.toolName}: "${clip(q.errorPattern, 80)}" (×${q.count}, last ${ageH}h ago)`);
        }
        lines.push('</tool_quirks>');
        return lines.join('\n') + '\n\n';
    } catch {
        return '';
    }
}

function buildMyRecentFires(jobId: string, peerId: string | undefined): string {
    if (!peerId) return '';
    try {
        const rows = getSharedLearningStore().getRecentProactiveDecisions(peerId, 7 * 24 * 60 * 60 * 1000, 30);
        const mine = rows.filter((r) => r.jobId === jobId).slice(0, 8);
        if (mine.length === 0) return '';
        const now = Date.now();
        const lines = ['<my_recent_fires>'];
        lines.push(`Your last ${mine.length} fires for this job (most recent first):`);
        let delivered = 0, suppressed = 0, errored = 0, responded = 0;
        for (const r of mine) {
            if (r.delivered === 1) delivered++;
            else if (r.delivered === 2) errored++;
            else suppressed++;
            if (r.userResponded === 1) responded++;
            const status = r.delivered === 1 ? 'delivered' : r.delivered === 2 ? 'error' : 'silent';
            const reason = r.silenceReason ? ` · ${r.silenceReason}` : '';
            const preview = r.messagePreview ? ` · "${clip(r.messagePreview, 80)}"` : '';
            lines.push(`  - ${fmtAgoMins(r.firedAt, now)} ${status}${reason}${preview}`);
        }
        const respRate = delivered > 0 ? Math.round((responded / delivered) * 100) : null;
        lines.push('');
        lines.push(`Totals (7d): ${delivered} delivered, ${suppressed} suppressed${errored > 0 ? `, ${errored} errored` : ''}${respRate !== null ? `, ${respRate}% user reply rate` : ''}`);
        if (suppressed >= 5 && delivered === 0) {
            lines.push('Pattern: you have suppressed many times without delivering. If THIS fire has a real anchor, prefer to deliver — silence is not free.');
        }
        lines.push('</my_recent_fires>');
        return lines.join('\n') + '\n\n';
    } catch {
        return '';
    }
}

const ENGAGEMENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const ENGAGEMENT_MIN_SAMPLE = 5;
const ENGAGEMENT_MAX_BYTES = 1200;

function engagementLabel(rate: number): string {
    return rate < 0.2 ? 'low' : rate < 0.5 ? 'mixed' : 'high';
}

// A deliver:true message that is a single whitespace-free token (e.g. "draft:gmail-stripe-reply")
// is a model misfire — it emitted an intent slug instead of real prose (and usually skipped the
// actual tool call). Ship nothing rather than a placeholder.
function isPlaceholderProactiveMessage(message: string): boolean {
    const t = message.trim();
    return t.length > 0 && !/\s/.test(t);
}

// The model captures sources in `citations` but often doesn't inline them in `message`;
// deliver only ships `message`, so append any citation whose URL isn't already in the text.
// Without this, news/factual claims go out with no link (e.g. the GitVenom Kaspersky item).
function appendCitations(
    message: string,
    citations?: ReadonlyArray<{ title: string; url: string; source?: string }>,
): string {
    if (!citations || citations.length === 0) return message;
    const missing = citations.filter((c) => c.url && !message.includes(c.url));
    if (missing.length === 0) return message;
    const lines = missing.map((c) => `• [${c.title}](${c.url})`);
    return `${message.trimEnd()}\n\nSources:\n${lines.join('\n')}`;
}

function engagementDaypart(hour: number): string {
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 15) return 'midday';
    if (hour >= 15 && hour < 19) return 'afternoon';
    return 'evening';
}

// Measured reply-rate per category+daypart so the agent calibrates its bar. Coarse buckets + min-sample gate avoid sparsity; the block never says "suppress" — that lever is the prompt's.
function buildEngagementStats(
    peerId: string | undefined,
    triggerKind: 'cron' | 'heartbeat',
    deliveryMode: 'always' | 'conditional' | 'silent',
): string {
    if (!peerId) return '';
    try {
        const rows = getSharedLearningStore()
            .getRecentProactiveDecisions(peerId, ENGAGEMENT_WINDOW_MS, 300)
            .filter((r) => r.delivered === 1);
        if (rows.length < ENGAGEMENT_MIN_SAMPLE) return '';

        const byCat = new Map<string, { n: number; r: number }>();
        const byPart = new Map<string, { n: number; r: number }>();
        let total = 0;
        let replied = 0;
        for (const row of rows) {
            total++;
            const got = row.userResponded === 1 ? 1 : 0;
            replied += got;
            const cat = row.category ?? 'uncategorized';
            const c = byCat.get(cat) ?? { n: 0, r: 0 };
            c.n++;
            c.r += got;
            byCat.set(cat, c);
            const part = engagementDaypart(new Date(row.firedAt).getHours());
            const p = byPart.get(part) ?? { n: 0, r: 0 };
            p.n++;
            p.r += got;
            byPart.set(part, p);
        }

        const fmtBuckets = (m: Map<string, { n: number; r: number }>): string[] =>
            [...m.entries()]
                .filter(([, v]) => v.n >= ENGAGEMENT_MIN_SAMPLE)
                .sort((a, b) => b[1].n - a[1].n)
                .map(([k, v]) => {
                    const rate = v.r / v.n;
                    return `${k} ${Math.round(rate * 100)}% (n=${v.n}) ${engagementLabel(rate)}`;
                });

        const catLines = fmtBuckets(byCat);
        const partLines = fmtBuckets(byPart);
        if (catLines.length === 0 && partLines.length === 0) return '';

        const lines = [
            `<engagement_stats window="14d" trigger="${triggerKind}">`,
            'Measured reply rate (user replied within 60min of delivery). Calibrate your bar; do NOT mechanically suppress. Buckets <5 samples are omitted (unknown → explore).',
            `overall: ${total > 0 ? Math.round((replied / total) * 100) : 0}% (n=${total})`,
        ];
        if (catLines.length > 0) lines.push(`by category: ${catLines.join(' · ')}`);
        if (partLines.length > 0) lines.push(`by daypart: ${partLines.join(' · ')}`);
        if (deliveryMode === 'always') {
            lines.push(
                'note: delivery:always — engagement tunes CONTENT EMPHASIS only, never whether to send.',
            );
        }
        lines.push('</engagement_stats>');
        const out = lines.join('\n') + '\n\n';
        return out.length > ENGAGEMENT_MAX_BYTES ? out.slice(0, ENGAGEMENT_MAX_BYTES) : out;
    } catch {
        return '';
    }
}

function buildDeliveryTargetHint(channelName: string | undefined): string {
    if (!channelName) return '';
    return `<delivery_target>\nchannel: ${channelName}. ${channelCapabilityHint(channelName)}\n</delivery_target>\n\n`;
}

/** Build an `<output_quality>` block with anti-patterns and recent topics. */
function buildQualityGuidance(store: StateStore): string {
    const recentTopics = store.getRecentTopics().slice(0, 8);
    const lines = [
        '<output_quality>',
        'A good proactive notification is:',
        '  - Specific: mentions concrete names, numbers, or dates — not vague summaries',
        '  - Actionable: the user can act on it immediately (reply, check, schedule)',
        '  - Concise: 1-3 sentences for most messages; longer only when complexity demands it',
        '  - Timely: lead with what changed or is due, not with background',
        '',
        'Anti-patterns to avoid:',
        '  - Opening with "Just wanted to let you know…" or "I noticed that…"',
        '  - Restating what the user already knows',
        '  - Padding with caveats and hedges instead of the actual information',
    ];
    if (recentTopics.length > 0) {
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const t of recentTopics) {
            if (t.topic && !seen.has(t.topic)) {
                seen.add(t.topic);
                unique.push(t.topic);
            }
        }
        if (unique.length > 0) {
            lines.push('');
            lines.push('Recent topics already covered (avoid repetition):');
            for (const topic of unique.slice(0, 6)) {
                lines.push(`  - ${topic}`);
            }
        }
    }
    lines.push('</output_quality>');
    return lines.join('\n') + '\n\n';
}

// ProactiveDecisionSchema is enforced by the React planner; result.structured is guaranteed valid.
type ProactiveOutput = ProactiveDecision;

/**
 * The `[SILENT]` text-token contract: when the agent emits exactly `[SILENT]`
 * (after trim) as its entire reply, the runtime suppresses delivery. This is
 * an additive, provider-agnostic alternative to `ProactiveDecisionSchema` —
 * structured-output / prefill is fragile on many providers under streaming,
 * but a plain text-token check works everywhere. Documented in
 * `src/team/templates/roles/main/proactive.md`.
 *
 * Predicate: trimmed reply, case-sensitive, exact match. `"[SILENT] follow-up"`
 * is NOT a sentinel — only the bare token counts.
 */
export function isSilentSentinel(reply: string | null | undefined): boolean {
    if (typeof reply !== 'string') return false;
    return reply.trim() === '[SILENT]';
}

export interface JobExecutorOptions {
    embedder?: ProactiveEmbedder;
    similarityThreshold: number;
    similarityWindowMs: number;
}

const log = createLogger('job-executor');

export class JobExecutor {
    private readonly embedder?: ProactiveEmbedder;
    private readonly similarityThreshold: number;
    private readonly similarityWindowMs: number;
    /** In-flight fires; engine.stop() awaits these before closing the dedupStore.
     *  Bounded by waitForInFlight(ms) so hung fires can't stall shutdown forever. */
    private readonly inFlight = new Set<Promise<unknown>>();

    constructor(
        private readonly agentCaller: AgentCaller,
        private readonly threadCleaner: ThreadCleaner,
        private readonly router: ChannelRouter,
        private readonly store: StateStore,
        private readonly dedupStore: ProactiveDedupStore,
        private readonly presence: PresenceManager,
        private readonly retryQueue: RetryQueue,
        options: JobExecutorOptions,
    ) {
        if (options.embedder) this.embedder = options.embedder;
        this.similarityThreshold = options.similarityThreshold;
        this.similarityWindowMs = options.similarityWindowMs;
    }

    /** Wait for in-flight fires to settle, with a hard cap. */
    async waitForInFlight(timeoutMs: number): Promise<void> {
        if (this.inFlight.size === 0) return;
        log.info({ inFlight: this.inFlight.size, timeoutMs }, 'engine stop: awaiting in-flight fires');
        const all = Promise.allSettled([...this.inFlight]);
        const timer = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, timeoutMs);
            t.unref();
        });
        await Promise.race([all, timer]);
        if (this.inFlight.size > 0) {
            log.warn(
                { remaining: this.inFlight.size },
                'engine stop: timeout reached with fires still in flight (their writes may 5xx against closed db)',
            );
        }
    }

    async execute(job: ExecutionJob): Promise<ExecutionResult> {
        const executePromise = this.executeImpl(job);
        this.inFlight.add(executePromise as Promise<unknown>);
        try {
            return await executePromise;
        } finally {
            this.inFlight.delete(executePromise as Promise<unknown>);
        }
    }

    private async executeImpl(job: ExecutionJob): Promise<ExecutionResult> {
        const startedAt = Date.now();
        const jobState = await this.store.getJobState(job.id);

        if (jobState.isExecuting) {
            // Stale-lock recovery: a stuck flag older than STALE_LOCK_MS is reclaimed.
            const since = jobState.executingSinceMs ?? 0;
            const heldFor = startedAt - since;
            if (since > 0 && heldFor > STALE_LOCK_MS) {
                log.warn(
                    { jobId: job.id, heldForMs: heldFor, staleLockMs: STALE_LOCK_MS },
                    'Stale isExecuting flag detected — reclaiming lock and proceeding',
                );
            } else {
                log.warn(
                    { jobId: job.id, heldForMs: heldFor },
                    'Job already executing, skipping',
                );
                return { action: 'suppressed', durationMs: 0 };
            }
        }

        log.info(
            { jobId: job.id, name: job.name, trigger: job.trigger, deliveryMode: job.deliveryMode },
            'executing job',
        );

        jobState.isExecuting = true;
        jobState.executingSinceMs = startedAt;
        await this.store.setJobState(job.id, jobState);

        try {
            const suppressCheck = await this.presence.shouldSuppress();
            if (suppressCheck.suppress && job.deliveryMode !== 'silent') {
                log.info({ jobId: job.id, reason: suppressCheck.reason }, 'suppressed by presence');
                return this.finalize(job, jobState, startedAt, 'suppressed');
            }

            // No-agent path: the script IS the job (watchdog/poll fires without LLM).
            if (job.noAgent && job.script) {
                return this.executeNoAgent(job, jobState, startedAt);
            }
            if (job.noAgent && !job.script) {
                log.warn(
                    { jobId: job.id },
                    'noAgent=true but script unset — skipping fire',
                );
                return this.finalize(job, jobState, startedAt, 'suppressed');
            }

            if (typeof job.cooldownAfterSilences === 'number' && job.cooldownAfterSilences > 0) {
                const peerIdForCooldown = job.delivery?.peer?.id;
                if (peerIdForCooldown) {
                    try {
                        const store = getSharedLearningStore();
                        const lookback = Math.max(10, job.cooldownAfterSilences + 5);
                        const rows = store
                            .getRecentProactiveDecisions(
                                peerIdForCooldown,
                                7 * 24 * 60 * 60 * 1000,
                                lookback,
                            )
                            .filter((r) => r.jobId === job.id);
                        let consecutive = 0;
                        for (const r of rows) {
                            if (r.delivered === 0) consecutive++;
                            else break;
                        }
                        if (consecutive >= job.cooldownAfterSilences) {
                            log.info(
                                {
                                    jobId: job.id,
                                    peerId: peerIdForCooldown,
                                    consecutive,
                                    threshold: job.cooldownAfterSilences,
                                },
                                'cooldown: consecutive deliver:false threshold reached, suppressing',
                            );
                            return this.finalize(job, jobState, startedAt, 'suppressed', {
                                structured: {
                                    deliver: false,
                                    silenceReason: 'cooldown',
                                    reason: `${consecutive} consecutive silent fires (threshold ${job.cooldownAfterSilences})`,
                                    confidence: 1.0,
                                },
                            });
                        }
                    } catch (err) {
                        log.warn(
                            { jobId: job.id, err: (err as Error).message },
                            'cooldown check failed — proceeding with fire',
                        );
                    }
                }
            }

            // Pre-check script gates the agent: `{"wakeAgent": false}` suppresses;
            // otherwise stdout becomes a `<pre_check>` block prepended to the prompt.
            let preCheckBlock = '';
            if (job.preCheckScript) {
                const pre = await this.runPreCheckScript(job);
                if (pre === null) {
                    return this.finalize(job, jobState, startedAt, 'suppressed');
                }
                preCheckBlock = pre;
            }

            if (job.deliveryMode === 'silent') {
                log.debug({ jobId: job.id }, 'executing in silent mode');
                return this.executeSilent(job, jobState, startedAt);
            }

            const threadId = job.threadId ?? `proactive:${job.id}:${Date.now()}`;
            const dateContext = buildDateContext();
            const qualityBlock = buildQualityGuidance(this.store);
            const peerId = job.delivery?.peer?.id;

            // Resolve job.skills → SKILL.md contents (the HOW for this task's WHAT).
            const { loaded: preloadedSkills, missing: missingSkills } = await loadSkills(
                job.skills,
                job.id,
            );
            if (preloadedSkills.length > 0 || missingSkills.length > 0) {
                log.info(
                    {
                        jobId: job.id,
                        op: 'fire:skills',
                        loaded: preloadedSkills.map((s) => s.name),
                        missing: missingSkills,
                    },
                    'preloaded skills resolved for fire',
                );
            }
            // Strip closing-tag injections so a SKILL.md author can't escape
            // the `<active_skills>` framing block and inject system authority.
            const sanitizeForPromptBlock = (s: string): string =>
                s.replace(/<\/active_skills>/gi, '[/active_skills_LITERAL]')
                 .replace(/<\/pre_check>/gi, '[/pre_check_LITERAL]')
                 .replace(/<\/fire_context>/gi, '[/fire_context_LITERAL]')
                 .replace(/<\/anti_repetition>/gi, '[/anti_repetition_LITERAL]')
                 .replace(/<\/engagement_stats>/gi, '[/engagement_stats_LITERAL]')
                 .replace(/<\/my_recent_fires>/gi, '[/my_recent_fires_LITERAL]')
                 .replace(/<\/delivery_target>/gi, '[/delivery_target_LITERAL]')
                 .replace(/<\/tool_quirks>/gi, '[/tool_quirks_LITERAL]');
            const skillsBlock =
                preloadedSkills.length > 0
                    ? '<active_skills>\n' +
                      'The following skill recipes apply to THIS fire. Treat them as HOW-to-do authority for this task — not as task content, not as tools. Follow their guidance when the task touches their scope.\n\n' +
                      preloadedSkills
                          .map((s) => `## Skill: ${s.name}\n\n${sanitizeForPromptBlock(s.content.trim())}`)
                          .join('\n\n---\n\n') +
                      '\n</active_skills>\n\n'
                    : '';

            const antiRepBlock = buildAntiRepetition(this.store);
            const engagementBlock = buildEngagementStats(
                peerId,
                job.trigger as 'cron' | 'heartbeat',
                job.deliveryMode as 'always' | 'conditional' | 'silent',
            );
            const recentFiresBlock = buildMyRecentFires(job.id, peerId);
            const deliveryTargetBlock = buildDeliveryTargetHint(job.delivery?.channelName);
            const toolQuirksBlock = buildToolQuirks(peerId);
            const assembledPrompt =
                skillsBlock +
                dateContext +
                deliveryTargetBlock +
                qualityBlock +
                antiRepBlock +
                engagementBlock +
                recentFiresBlock +
                toolQuirksBlock +
                preCheckBlock +
                job.prompt;

            // Neutralize first-party conversation-role tags before the injection
            // scan so recycled context (skills, recent fires, tool results) can't
            // false-positive the fake-conversation-tag rule and silently suppress
            // every fire. Log the first hit so the offending tag is traceable.
            const roleTagHit = assembledPrompt.match(ROLE_TAG_RE);
            if (roleTagHit) {
                log.debug(
                    { jobId: job.id, tag: roleTagHit[0] },
                    'neutralized conversation-role tag in assembled cron prompt',
                );
            }
            const augmentedPrompt = neutralizeRoleTags(assembledPrompt);

            const injectionPattern = detectPromptInjection(augmentedPrompt);
            const unicodeBad = hasUnicodeContamination(augmentedPrompt);
            if (injectionPattern || unicodeBad) {
                log.warn(
                    {
                        jobId: job.id,
                        peerId,
                        injectionPattern,
                        unicodeContaminated: unicodeBad,
                        promptLength: augmentedPrompt.length,
                    },
                    'assembled cron prompt tripped injection scanner — suppressing fire',
                );
                return this.finalize(job, jobState, startedAt, 'suppressed', {
                    structured: {
                        deliver: false,
                        silenceReason: 'injection_blocked',
                        reason: injectionPattern ?? 'unicode-contamination',
                        confidence: 1.0,
                    },
                });
            }

            let response: string;
            // `structured` is enforced by the React planner via __respond__ — guaranteed valid.
            let structured: ProactiveOutput | undefined;

            try {
                const agentOptions = {
                    threadId,
                    ...(job.personality ? { personality: job.personality } : {}),
                    deliveryMode: job.deliveryMode,
                };
                const result = await this.agentCaller(augmentedPrompt, agentOptions);
                response = result.response;
                structured = (result as { structured?: ProactiveOutput }).structured;

                log.info(
                    {
                        jobId: job.id,
                        threadId,
                        deliveryMode: job.deliveryMode,
                        structuredPresent: !!structured,
                        structuredDeliver: structured?.deliver ?? null,
                        structuredCategory: structured?.deliver === true
                            ? structured.category
                            : structured?.deliver === false
                                ? structured.silenceReason
                                : null,
                        structuredMessageLength: structured?.deliver === true
                            ? structured.message?.length ?? 0
                            : 0,
                        structuredConfidence: structured?.confidence ?? null,
                        responseLength: response?.length ?? 0,
                    },
                    'agent returned (primary call)',
                );
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                log.error({ jobId: job.id, threadId, err }, 'Agent call failed');
                return this.finalizeError(job, jobState, startedAt, error);
            } finally {
                if (!job.threadId) {
                    await this.threadCleaner(threadId).catch((cleanupErr: unknown) => {
                        log.warn(
                            { err: cleanupErr, jobId: job.id, threadId, op: 'threadCleaner' },
                            'ephemeral thread cleanup failed — potential memory leak',
                        );
                    });
                }
            }

            // [SILENT] sentinel: fast-path text-token suppression. Runs BEFORE the
            // structured/Zod path so a model that emits the sentinel never has to
            // also satisfy the schema. Additive — models that don't know about
            // [SILENT] keep working via the existing structured/always paths.
            if (isSilentSentinel(response)) {
                log.info(
                    {
                        jobId: job.id,
                        name: job.name,
                        deliveryMode: job.deliveryMode,
                    },
                    'suppressed via [SILENT] sentinel',
                );
                const sentinelStructured: ProactiveOutput = {
                    deliver: false,
                    silenceReason: 'silent_sentinel',
                    reason: 'agent emitted [SILENT] sentinel',
                    confidence: 1.0,
                };
                return this.finalize(
                    job,
                    jobState,
                    startedAt,
                    'suppressed',
                    { structured: sentinelStructured },
                );
            }

            // Track REPORTED: IDs regardless of mode — agent emits them even in `always`.
            this.recordReportedFromText(response, job).catch((err) =>
                log.debug({ err, jobId: job.id }, 'REPORTED: parse failed'),
            );

            // Structured present → always treat as non-empty (both deliver:true and
            // deliver:false are valid outcomes); only call empty when neither exists.
            const hasValidStructured =
                structured !== undefined &&
                structured !== null &&
                typeof structured.deliver === 'boolean';

            if (!response?.trim() && !hasValidStructured) {
                // `always` mode requires SOMETHING; ship a fallback notice on infra failure.
                log.warn(
                    { jobId: job.id, deliveryMode: job.deliveryMode, name: job.name },
                    'agent returned empty response (check model timeout or prompt issues)',
                );
                if (job.deliveryMode === 'always') {
                    const now = new Date();
                    const hhmm = now.toLocaleTimeString('en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                    });
                    const fallback =
                        `⚠️ ${job.name} fired at ${hhmm} but couldn't compose ` +
                        `(workers timed out or model overloaded). ` +
                        `Run \`flopsy cron trigger ${job.id}\` to retry, or check ` +
                        `\`flopsy cron stats ${job.id}\` for failure history.`;
                    return this.deliverResponse(job, jobState, startedAt, fallback, {});
                }
                // Conditional/silent: suppress + record empty_agent_response for ops visibility.
                const reason = job.preCheckScript
                    ? 'Agent returned empty after pre-check ran. Investigate: model timeout, worker abort cascade, or structured-output schema rejection.'
                    : 'Agent returned empty response (likely model bypassed __respond__). Cause candidates: weak meta-tool compliance on the configured model, worker abort cascade, model timeout (modelCallTimeoutMs / parent envelope), or structured-output schema rejection.';
                const syntheticStructured: ProactiveOutput = {
                    deliver: false,
                    silenceReason: 'empty_agent_response',
                    reason,
                    confidence: 0.0,
                };
                // Mirror the regular deliver:false path: write the suppression to
                // BOTH the persistent store and the dedup sidecar so /status,
                // proactive.json's recentSuppressions, and the agent's "recent
                // suppression history" prompt actually see this entry. Without
                // this, empty-response fires inflate suppressedCount silently and
                // recentSuppressions stops getting new entries — exactly the
                // bug behind "smart-pulse didn't deliver and I can't see why".
                try {
                    await this.store.addSuppression(reason, job.id, { reason });
                    this.dedupStore.recordSuppression(job.id, reason, {
                        mode: null,
                        overlay: null,
                        reason,
                    });
                } catch (recordErr) {
                    log.warn(
                        { err: recordErr instanceof Error ? recordErr.message : String(recordErr), jobId: job.id },
                        'failed to record empty-response suppression (non-fatal)',
                    );
                }
                return this.finalize(
                    job,
                    jobState,
                    startedAt,
                    'suppressed',
                    { structured: syntheticStructured },
                );
            }

            if (job.deliveryMode === 'conditional') {
                return this.executeConditional(job, jobState, startedAt, response, structured);
            }

            // Always-mode jobs may still suppress when `deliver: false` is emitted.
            if (structured && structured.deliver === false) {
                log.info(
                    {
                        jobId: job.id,
                        name: job.name,
                        deliveryMode: job.deliveryMode,
                        silenceReason: structured.silenceReason,
                        agentReason: structured.reason,
                        confidence: structured.confidence,
                    },
                    'always-mode: agent chose deliver=false (suppressed)',
                );
                return this.finalize(job, jobState, startedAt, 'suppressed', { structured });
            }

            // structured.message is schema-guaranteed when deliver === true;
            // fall back to raw response only when isProactive wasn't set.
            const deliveryText: string =
                structured?.deliver === true
                    ? structured.message!
                    : stripReportedLines(response);
            if (structured?.deliver === true && isPlaceholderProactiveMessage(deliveryText)) {
                log.warn(
                    { jobId: job.id, name: job.name, message: deliveryText.trim().slice(0, 80) },
                    'always-mode: placeholder/slug message — delivering fallback notice instead',
                );
                const fallback = `⚠️ ${job.name} composed only a placeholder ("${deliveryText.trim().slice(0, 40)}"). Run \`flopsy cron trigger ${job.id}\` to retry.`;
                return this.deliverResponse(job, jobState, startedAt, fallback, { structured });
            }
            log.info(
                {
                    jobId: job.id,
                    deliverySource:
                        structured?.deliver === true ? 'structured.message' : 'raw response',
                    category: structured?.deliver === true ? structured.category : null,
                    confidence: structured?.confidence ?? null,
                    deliveryTextPreview: deliveryText.slice(0, 200),
                    deliveryTextLength: deliveryText.length,
                },
                'delivering (always mode)',
            );
            return this.deliverResponse(
                job,
                jobState,
                startedAt,
                appendCitations(deliveryText, structured?.deliver === true ? structured.citations : undefined),
                { structured },
            );
        } finally {
            jobState.isExecuting = false;
            jobState.executingSinceMs = undefined;
            await this.store.setJobState(job.id, jobState);
        }
    }

    /** No-agent fire: run job.script, deliver stdout; empty stdout = silent. */
    private async executeNoAgent(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
    ): Promise<ExecutionResult> {
        log.info({ jobId: job.id, script: job.script }, 'executing no-agent (script-only)');
        let result;
        try {
            result = await runScript(job.script!);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return this.finalizeError(job, jobState, startedAt, `script setup failed: ${msg}`);
        }

        // Failure path: alert with capped stderr so operators can diagnose.
        if (result.exitCode !== 0) {
            const alert =
                `⚠️ ${job.name} watchdog: exit ${result.exitCode}` +
                (result.timedOut ? ' (timeout)' : '') +
                (result.stderr ? `\n${result.stderr.slice(0, 800)}` : '');
            return this.deliverResponse(job, jobState, startedAt, alert, {});
        }

        // Success path: empty stdout = silent (watchdog reports only on problems).
        const trimmed = result.stdout.trim();
        if (!trimmed) {
            log.debug({ jobId: job.id }, 'no-agent: empty stdout — silent tick');
            return this.finalize(job, jobState, startedAt, 'suppressed');
        }
        return this.deliverResponse(job, jobState, startedAt, trimmed, {});
    }

    /**
     * Run the pre-check script and return either a `<pre_check>` block to
     * prepend to the agent prompt, or null to signal full suppression.
     *
     * Failures (script exits non-zero, throws, times out) are NON-fatal:
     * we log and fall through to running the agent normally. The agent's
     * own behaviour is the safer default — refusing to fire because a
     * monitoring script flaked is worse UX than firing without that hint.
     */
    private async runPreCheckScript(job: ExecutionJob): Promise<string | null> {
        const PRE_CHECK_CONTEXT_CAP_BYTES = 4_000;
        let result;
        try {
            result = await runScript(job.preCheckScript!);
        } catch (err) {
            log.warn(
                { jobId: job.id, err: err instanceof Error ? err.message : String(err) },
                'pre-check script setup failed — running agent without it',
            );
            return '';
        }

        if (result.exitCode !== 0) {
            log.warn(
                {
                    jobId: job.id,
                    exitCode: result.exitCode,
                    timedOut: result.timedOut,
                    stderrPreview: result.stderr.slice(0, 200),
                },
                'pre-check script failed — running agent without context',
            );
            return '';
        }

        if (!result.wakeAgent) {
            log.info(
                { jobId: job.id, script: job.preCheckScript },
                'pre-check signalled wakeAgent=false — suppressing fire',
            );
            return null;
        }

        const body = result.stdout.trim();
        if (!body) return '';
        // Strip wakeAgent sentinel lines — they shouldn't end up in context.
        const stripped = body
            .split('\n')
            .filter((line) => {
                const t = line.trim();
                return !(t.startsWith('{') && t.includes('"wakeAgent"'));
            })
            .join('\n')
            .trim();
        if (!stripped) return '';
        const clipped =
            stripped.length > PRE_CHECK_CONTEXT_CAP_BYTES
                ? stripped.slice(0, PRE_CHECK_CONTEXT_CAP_BYTES) + '\n[...truncated]'
                : stripped;
        // Strip closing-tag injections — scripts may relay untrusted webhook data.
        const safe = clipped
            .replace(/<\/pre_check>/gi, '[/pre_check_LITERAL]')
            .replace(/<\/active_skills>/gi, '[/active_skills_LITERAL]')
            .replace(/<\/fire_context>/gi, '[/fire_context_LITERAL]');
        return `<pre_check script="${job.preCheckScript}">\n${safe}\n</pre_check>\n\n`;
    }

    private async executeSilent(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
    ): Promise<ExecutionResult> {
        const threadId = job.threadId ?? `proactive:${job.id}:${Date.now()}`;
        try {
            await this.agentCaller(job.prompt, {
                threadId,
                ...(job.personality ? { personality: job.personality } : {}),
            });
            return this.finalize(job, jobState, startedAt, 'suppressed');
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return this.finalizeError(job, jobState, startedAt, error);
        } finally {
            if (!job.threadId) {
                await this.threadCleaner(threadId).catch((cleanupErr: unknown) => {
                    log.warn(
                        { err: cleanupErr, jobId: job.id, threadId, op: 'threadCleaner:silent' },
                        'silent-mode ephemeral thread cleanup failed',
                    );
                });
            }
        }
    }

    private async executeConditional(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
        response: string,
        structured?: ProactiveOutput,
    ): Promise<ExecutionResult> {
        if (structured) {
            // deliver:false branch has silenceReason but structurally no `message`.
            if (structured.deliver === false) {
                log.info(
                    {
                        jobId: job.id,
                        name: job.name,
                        silenceReason: structured.silenceReason,
                        consideredCategory: structured.consideredCategory ?? null,
                        agentReason: structured.reason,
                        confidence: structured.confidence,
                        contextUsedCount: structured.contextUsed?.length ?? 0,
                        actionsTakenCount: structured.actionsTaken?.length ?? 0,
                    },
                    'Conditional: agent chose deliver=false (suppressed)',
                );
                // Mirror suppression to both SQLite + JSON sidecar for /status queries.
                await this.store.addSuppression(structured.reason, job.id, {
                    reason: structured.reason,
                });
                this.dedupStore.recordSuppression(job.id, structured.reason, {
                    mode: null,
                    overlay: null,
                    reason: structured.reason,
                });
                return this.finalize(job, jobState, startedAt, 'suppressed', { structured });
            }

            // Schema's superRefine guarantees message + category exist on deliver:true.
            const message = structured.message!;
            if (isPlaceholderProactiveMessage(message)) {
                const reason =
                    `Suppressed placeholder/slug message ("${message.trim().slice(0, 60)}") — ` +
                    `model emitted an intent label instead of real content (and likely skipped the actual action). ` +
                    `actionsTaken=${structured.actionsTaken?.length ?? 0}.`;
                log.warn(
                    { jobId: job.id, name: job.name, message: message.trim().slice(0, 80) },
                    'conditional: placeholder/slug message suppressed (not delivered)',
                );
                await this.store.addSuppression(reason, job.id, { reason });
                this.dedupStore.recordSuppression(job.id, reason, { mode: null, overlay: null, reason });
                return this.finalize(job, jobState, startedAt, 'suppressed', { structured });
            }
            if (structured.reportedIds) {
                await this.recordReportedIds(structured.reportedIds, job.id);
            }
            return this.deliverResponse(
                job,
                jobState,
                startedAt,
                appendCitations(stripReportedLines(message).slice(0, 4000), structured.citations),
                { structured },
                { reason: structured.reason },
            );
        }

        // Fallback path — only reachable when team-agent lacks isProactive (config error).
        log.warn(
            { jobId: job.id, name: job.name },
            'executeConditional: no structured output — proactive agent likely missing outputSchema',
        );
        const decision = parseConditionalResponse(response);

        if (!decision || decision.status === 'suppress') {
            const reason = decision?.reason ?? 'Agent suppressed (no parseable status)';
            log.info(
                {
                    jobId: job.id,
                    name: job.name,
                    parseStatus: decision === null ? 'unparseable' : 'status=suppress',
                    reason,
                    responseLength: response.length,
                    responsePreview: decision === null ? response.slice(0, 400) : null,
                },
                'Conditional: suppressed (fallback string-parse path)',
            );
            return this.finalize(job, jobState, startedAt, 'suppressed');
        }

        const raw = decision.content ?? response;
        const content = typeof raw === 'string' ? raw.slice(0, 4000) : response;
        return this.deliverResponse(job, jobState, startedAt, stripReportedLines(content), {
            structured,
        });
    }

    /** Mirror reported IDs to both SQLite (fast lookup) and JSON (durable). */
    private async recordReportedIds(
        reportedIds: ReportedIds,
        source: string,
    ): Promise<void> {
        for (const type of ['emails', 'meetings', 'tasks', 'news'] as const) {
            const ids = reportedIds[type];
            if (ids && ids.length > 0) {
                this.dedupStore.markReported(type, ids, source);
                for (const id of ids) {
                    await this.store.addReportedItem(type, id);
                }
            }
        }
    }

    private async recordReportedFromText(text: string, job: ExecutionJob): Promise<void> {
        const parsed = parseReportedLines(text, job.name);
        for (const type of ['emails', 'meetings', 'tasks', 'news'] as const) {
            if (parsed[type].length > 0) {
                this.dedupStore.markReported(type, parsed[type], job.id);
                for (const id of parsed[type]) {
                    await this.store.addReportedItem(type, id);
                }
            }
        }
    }

    private async deliverResponse(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
        text: string,
        ctx: DecisionContext = {},
        meta: { mode?: string | null; overlay?: string | null; reason?: string | null } = {},
    ): Promise<ExecutionResult> {
        let embedding: number[] | undefined;
        if (this.embedder) {
            try {
                embedding = await this.embedder.embed(text);
            } catch (err) {
                log.warn({ jobId: job.id, err }, 'embedder failed — skipping similarity dedup');
            }
        }

        // Skip similarity dedup for 'always' — that contract requires every-tick delivery.
        if (embedding && job.deliveryMode !== 'always') {
            const match = this.dedupStore.findSimilar(
                embedding,
                this.similarityThreshold,
                this.similarityWindowMs,
            );
            if (match) {
                log.info(
                    {
                        jobId: job.id,
                        similarity: match.similarity.toFixed(3),
                        matchedSource: match.source,
                        agoMs: Date.now() - match.deliveredAt,
                    },
                    'Suppressed — semantically similar delivery within window',
                );
                return this.finalize(job, jobState, startedAt, 'suppressed', ctx);
            }
        }

        // Fire-and-deliver: standard cron semantics. Only DND/quiet-hours gate.
        const result = await this.router.deliver(job.delivery, text);

        if (!result.delivered) {
            await this.retryQueue.add({
                id: `retry_${job.id}_${Date.now()}`,
                type: 'job',
                job: {
                    id: job.id,
                    name: job.name,
                    trigger: job.trigger,
                    prompt: job.prompt,
                    delivery: job.delivery,
                    deliveryMode: job.deliveryMode,
                },
            });
            return this.finalizeError(job, jobState, startedAt, result.error ?? 'Delivery failed');
        }

        await this.store.addDelivery(text, job.id);
        this.dedupStore.recordDelivery(job.id, text, embedding, {
            ...(meta.mode !== undefined ? { mode: meta.mode } : {}),
            ...(meta.overlay !== undefined ? { overlay: meta.overlay } : {}),
            ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
        });
        // Force sync flush — StateStore's 10s lazy flush would lose deliveries on crash.
        this.store.flushNow();
        return this.finalize(job, jobState, startedAt, 'delivered', {
            ...ctx,
            deliveryText: text,
        });
    }

    private async finalize(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
        action: ExecutionResult['action'],
        ctx: DecisionContext = {},
    ): Promise<ExecutionResult> {
        const durationMs = Date.now() - startedAt;

        jobState.lastRunAt = Date.now();
        jobState.lastStatusAt = Date.now();
        jobState.lastStatus = 'success';
        jobState.lastAction = action;
        jobState.lastError = undefined;
        jobState.runCount++;
        jobState.consecutiveErrors = 0;
        jobState.nextBackoffMs = undefined;

        if (action === 'delivered') jobState.deliveredCount++;
        if (action === 'suppressed') jobState.suppressedCount++;
        if (action === 'queued') jobState.queuedCount++;

        await this.store.setJobState(job.id, jobState);

        const level = action === 'delivered' ? 'info' : 'debug';
        log[level](
            {
                jobId: job.id,
                name: job.name,
                trigger: job.trigger,
                action,
                durationMs,
                runCount: jobState.runCount,
            },
            `job ${action}`,
        );

        // Persist for self-improve loop — best-effort.
        try {
            this.recordProactiveDecision(job, startedAt, durationMs, action, ctx);
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err), jobId: job.id },
                'failed to record proactive decision (non-fatal)',
            );
        }

        // Hook fan-out: `proactive.fire.{delivered|suppressed|error}` — fire-and-forget.
        emitHook(`proactive.fire.${action}`, {
            jobId: job.id,
            jobName: job.name,
            trigger: job.trigger,
            deliveryMode: job.deliveryMode,
            channel: job.delivery?.channelName,
            peerId: job.delivery?.peer?.id,
            peerType: job.delivery?.peer?.type,
            action,
            durationMs,
            startedAt: new Date(startedAt).toISOString(),
            category: ctx.structured?.deliver === true ? ctx.structured.category : undefined,
            silenceReason:
                ctx.structured?.deliver === false ? ctx.structured.silenceReason : undefined,
            confidence: ctx.structured?.confidence,
            reason: ctx.structured?.reason,
            messageLen: (ctx.deliveryText ?? '').length,
            messagePreview: ctx.deliveryText
                ? ctx.deliveryText.slice(0, 200) + (ctx.deliveryText.length > 200 ? '…' : '')
                : undefined,
            skills: job.skills,
        });

        return { action, durationMs };
    }

    private recordProactiveDecision(
        job: ExecutionJob,
        firedAt: number,
        durationMs: number,
        action: ExecutionResult['action'],
        ctx: DecisionContext,
    ): void {
        const peerId = job.delivery?.peer?.id;
        if (!peerId) return; // No peer = nothing to scope; skip silently.

        const structured = ctx.structured;
        const deliveryText = ctx.deliveryText ?? '';
        const delivered: 0 | 1 | 2 =
            action === 'delivered' ? 1 : action === 'error' ? 2 : 0;

        let category: string | null = null;
        let silenceReason: string | null = null;
        let confidence: number | null = null;
        let reason: string | null = null;
        if (structured) {
            confidence = structured.confidence ?? null;
            reason = (structured.reason ?? '').slice(0, 500) || null;
            if (structured.deliver === true) {
                category = structured.category ?? null;
            } else if (structured.deliver === false) {
                silenceReason = structured.silenceReason ?? null;
            }
        }

        getSharedLearningStore().recordProactiveDecision({
            peerId,
            jobId: job.id,
            jobName: job.name ?? null,
            triggerKind: job.trigger as 'cron' | 'heartbeat',
            firedAt,
            durationMs,
            deliveryMode: job.deliveryMode as 'always' | 'conditional' | 'silent',
            delivered,
            hasStructured: structured ? 1 : 0,
            category,
            silenceReason,
            confidence,
            reason,
            messagePreview: deliveryText ? deliveryText.slice(0, 500) : null,
            messageLen: deliveryText.length,
            userResponded: 0,
            responseAt: null,
        });
    }

    private async finalizeError(
        job: ExecutionJob,
        jobState: ReturnType<typeof getDefaultJobState>,
        startedAt: number,
        error: string,
    ): Promise<ExecutionResult> {
        const durationMs = Date.now() - startedAt;

        jobState.lastRunAt = Date.now();
        jobState.lastStatusAt = Date.now();
        jobState.lastStatus = 'error';
        jobState.lastAction = 'error';
        jobState.lastError = error;
        jobState.runCount++;
        jobState.consecutiveErrors++;

        const backoffIdx = Math.min(jobState.consecutiveErrors - 1, BACKOFF_SCHEDULE_MS.length - 1);
        jobState.nextBackoffMs = BACKOFF_SCHEDULE_MS[Math.max(0, backoffIdx)];

        await this.store.setJobState(job.id, jobState);

        log.error({ jobId: job.id, error, consecutive: jobState.consecutiveErrors }, 'Job failed');

        return { action: 'error', error, durationMs };
    }
}

/**
 * Parse a conditional-mode agent response. Accepts modern `{shouldDeliver, ...}`,
 * legacy `{status, ...}`, and either wrapped in code fences. Returns null on no match
 * (callers treat null as suppress, so malformed replies never fire deliveries).
 */
export function parseConditionalResponse(text: string): ConditionalResponse | null {
    // Try every candidate JSON region we can extract.
    for (const candidate of extractJsonCandidates(text)) {
        const adapted = tryParseEither(candidate);
        if (adapted) return adapted;
    }
    return null;
}

/** Yield plausible JSON substrings: raw, fenced, backtick-wrapped.
 *  Prose-wrapped JSON is intentionally NOT extracted — for a delivery
 *  decision, an LLM that responds with rambling rather than structured
 *  output is treated as suppress, not coerced into a delivery. */
function* extractJsonCandidates(text: string): IterableIterator<string> {
    const trimmed = text.trim();
    yield trimmed;

    const tripleFence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (tripleFence?.[1]) yield tripleFence[1].trim();

    const singleBacktick = trimmed.match(/^`(.+)`$/s);
    if (singleBacktick?.[1]) yield singleBacktick[1].trim();
}

/** Parse one candidate as modern or legacy shape; null on no match. */
function tryParseEither(jsonText: string): ConditionalResponse | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;

    // Modern: {shouldDeliver, message?, reason?, topics?}
    if (typeof obj.shouldDeliver === 'boolean') {
        const reason = typeof obj.reason === 'string' ? obj.reason : '';
        const message = typeof obj.message === 'string' ? obj.message : undefined;
        return obj.shouldDeliver
            ? { status: 'promote', reason, ...(message !== undefined ? { content: message } : {}) }
            : { status: 'suppress', reason };
    }

    // Legacy: {status: 'promote'|'suppress', reason, content?}
    if (obj.status === 'promote' || obj.status === 'suppress') {
        const reason = typeof obj.reason === 'string' ? obj.reason : '';
        const content = typeof obj.content === 'string' ? obj.content : undefined;
        return content !== undefined
            ? { status: obj.status, reason, content }
            : { status: obj.status, reason };
    }

    return null;
}
