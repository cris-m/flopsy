import { createLogger } from '@flopsy/shared';
import type { JobExecutor } from '../pipeline/executor';
import type { PresenceManager } from '../state/presence';
import type { StateStore } from '../state/store';
import type { HeartbeatDefinition, DeliveryTarget, ExecutionJob } from '../types';
import type { PromptLoader } from '../prompt-loader';
import { buildProactiveSelfReviewBlock } from '../self-review';
import { parseDurationMs } from '../duration';

const log = createLogger('heartbeat');

interface HeartbeatEntry {
    definition: HeartbeatDefinition;
    timer: ReturnType<typeof setInterval> | null;
    // Undefined means "resolve at fire time via engine.resolveDelivery()".
    deliveryOverride: DeliveryTarget | undefined;
    firing: boolean;
}

export class HeartbeatTrigger {
    private entries: Map<string, HeartbeatEntry> = new Map();
    private running = false;
    private lastFiredAt: number | null = null;
    /** Set by engine; resolved per-fire so followActiveChannel sees live state. */
    resolveDelivery: (override?: DeliveryTarget) => DeliveryTarget | null = (o) => o ?? null;

    /** Maps a fire to the peer's active session threadId. */
    threadIdResolver?: (
        channelName: string,
        peer: { id: string; type: 'user' | 'group' | 'channel' },
        source: 'heartbeat' | 'cron',
    ) => string | undefined;

    constructor(
        private readonly executor: JobExecutor,
        private readonly presence: PresenceManager,
        private readonly store: StateStore,
        private readonly promptLoader?: PromptLoader,
    ) {}

    getLastFiredAt(): number | undefined {
        return this.lastFiredAt ?? undefined;
    }

    async start(heartbeats: HeartbeatDefinition[], _defaultDelivery: DeliveryTarget): Promise<void> {
        if (this.running) return;
        this.running = true;

        for (const hb of heartbeats) {
            this.registerOne(hb);
        }
    }

    /** Returns false if skipped (disabled / already-fired oneshot / invalid / dup). */
    addHeartbeat(hb: HeartbeatDefinition, _defaultDelivery: DeliveryTarget): boolean {
        if (this.entries.has(hb.name)) {
            log.warn({ name: hb.name }, 'Heartbeat already registered — skipping');
            return false;
        }
        return this.registerOne(hb);
    }

    /** Does NOT remove the persisted runtime-schedule row. */
    removeHeartbeat(name: string): boolean {
        const entry = this.entries.get(name);
        if (!entry) return false;
        if (entry.timer) clearInterval(entry.timer);
        this.entries.delete(name);
        return true;
    }

    /** Names of currently-registered heartbeats. Used by `engine.reloadSchedules()`. */
    listNames(): string[] {
        return Array.from(this.entries.keys());
    }

    private registerOne(hb: HeartbeatDefinition): boolean {
        if (!hb.enabled) return false;
        const oneshotKey = hb.id ?? `heartbeat-${hb.name}`;
        if (hb.oneshot && this.store.isOneshotCompleted(oneshotKey)) {
            log.info(
                { name: hb.name, oneshotKey },
                'One-shot heartbeat already completed in prior run — skipping',
            );
            return false;
        }
        const intervalMs = parseDurationMs(hb.interval);
        if (!intervalMs) {
            log.warn({ name: hb.name, interval: hb.interval }, 'Invalid interval, skipping');
            return false;
        }

        const entry: HeartbeatEntry = {
            definition: { ...hb },
            timer: null,
            deliveryOverride: hb.delivery,
            firing: false,
        };

        if (hb.oneshot) {
            void this.fireOnce(entry).catch((err) => {
                log.error({ name: hb.name, err }, 'One-shot heartbeat failed');
            });
        } else {
            entry.timer = setInterval(() => {
                if (entry.firing) {
                    log.debug(
                        { name: hb.name },
                        'Heartbeat still running from previous tick, skipping',
                    );
                    return;
                }
                entry.firing = true;
                void this.fire(entry).finally(() => {
                    entry.firing = false;
                });
            }, intervalMs);
            entry.timer.unref();
        }

        this.entries.set(hb.name, entry);
        log.info(
            { name: hb.name, interval: hb.interval, oneshot: !!hb.oneshot },
            'Heartbeat registered',
        );
        return true;
    }

    stop(): void {
        this.running = false;
        for (const entry of this.entries.values()) {
            if (entry.timer) {
                clearInterval(entry.timer);
                entry.timer = null;
            }
        }
        this.entries.clear();
    }

    /** Manually fire; dispatches immediately and runs the LLM call detached. */
    triggerNow(name: string, context?: Record<string, unknown>): boolean {
        const entry = this.entries.get(name);
        if (!entry) return false;
        void this.fire(entry, context).catch((err) => {
            log.error(
                { heartbeat: name, err: err instanceof Error ? err.message : String(err) },
                'manually-triggered heartbeat fire failed',
            );
        });
        return true;
    }

    private async fire(entry: HeartbeatEntry, context?: Record<string, unknown>): Promise<void> {
        const { definition: hb } = entry;

        if (hb.activeHours) {
            const inHours = await this.presence.isInActiveHours(
                hb.activeHours.start,
                hb.activeHours.end,
                hb.activeHours.timezone,
            );
            if (!inHours) {
                log.debug({ name: hb.name }, 'Outside active hours, skipping');
                return;
            }
        }

        // Pre-flight DND check — saves LLM tokens by skipping before agent invocation.
        if (hb.deliveryMode !== 'silent') {
            const suppress = await this.presence.shouldSuppress();
            if (suppress.suppress) {
                log.debug(
                    { name: hb.name, reason: suppress.reason },
                    'DND/quiet-hours active — skipping fire (saves LLM tokens)',
                );
                return;
            }
        }

        const delivery = this.resolveDelivery(entry.deliveryOverride);
        if (!delivery) {
            log.warn(
                { name: hb.name },
                'No delivery target — skipping fire',
            );
            return;
        }

        // Stamp before execute so /status shows in-flight heartbeats.
        this.lastFiredAt = Date.now();

        const prompt = this.promptLoader
            ? await this.promptLoader.resolve(hb.prompt, hb.promptFile, 'heartbeat').catch((err) => {
                  log.error({ name: hb.name, err }, 'Failed to load promptFile — skipping fire');
                  return null;
              })
            : hb.prompt;
        if (prompt === null) return;

        // self-improve fires with a pre-computed `<proactive_self_review>`
        // block prepended. If the block is empty (no anti-patterns), the
        // prompt instructs the agent to bail with a single `OK`.
        let finalPrompt = prompt;
        if (hb.name === 'self-improve') {
            const block = buildProactiveSelfReviewBlock(delivery.peer.id, 24 * 60 * 60 * 1000);
            if (block) finalPrompt = `${block}\n\n${prompt}`;
        }

        const resolvedThreadId = this.threadIdResolver?.(delivery.channelName, delivery.peer, 'heartbeat');
        const job: ExecutionJob = {
            id: hb.id ?? `heartbeat-${hb.name}`,
            name: hb.name,
            trigger: 'heartbeat',
            prompt: finalPrompt,
            delivery,
            deliveryMode: hb.deliveryMode,
            context,
            ...(resolvedThreadId ? { threadId: resolvedThreadId } : {}),
            ...(hb.noAgent ? { noAgent: true } : {}),
            ...(hb.script ? { script: hb.script } : {}),
            ...(hb.preCheckScript ? { preCheckScript: hb.preCheckScript } : {}),
            ...(hb.skills && hb.skills.length > 0 ? { skills: hb.skills } : {}),
        };

        await this.executor.execute(job).catch((err) => {
            log.error({ name: hb.name, err }, 'Heartbeat execution failed');
        });
    }

    private async fireOnce(entry: HeartbeatEntry): Promise<void> {
        await this.fire(entry);
        entry.definition.enabled = false;
        // Persist completion so a restart doesn't re-fire (config still
        // says oneshot:true, enabled:true).
        const oneshotKey = entry.definition.id ?? `heartbeat-${entry.definition.name}`;
        this.store.markOneshotCompleted(oneshotKey);
        log.info(
            { name: entry.definition.name, oneshotKey },
            'One-shot heartbeat completed, disabled + marked in state',
        );
    }
}
