import { createLogger } from '@flopsy/shared';
import type { JobExecutor, HeartbeatDefinition, DeliveryTarget, ExecutionJob, PresenceManager } from '@shared/types';

const log = createLogger('heartbeat');

interface HeartbeatEntry {
    definition: HeartbeatDefinition;
    timer: ReturnType<typeof setInterval> | null;
    defaultDelivery: DeliveryTarget;
}

export class HeartbeatTrigger {
    private entries: Map<string, HeartbeatEntry> = new Map();
    private running = false;

    constructor(
        private readonly executor: JobExecutor,
        private readonly presence: PresenceManager,
    ) {}

    async start(heartbeats: HeartbeatDefinition[], defaultDelivery: DeliveryTarget): Promise<void> {
        if (this.running) return;
        this.running = true;

        for (const hb of heartbeats) {
            if (!hb.enabled) continue;
            const intervalMs = parseInterval(hb.interval);
            if (!intervalMs) {
                log.warn({ name: hb.name, interval: hb.interval }, 'Invalid interval, skipping');
                continue;
            }

            const delivery = hb.delivery ?? defaultDelivery;
            const entry: HeartbeatEntry = {
                definition: { ...hb },
                timer: null,
                defaultDelivery: delivery,
            };

            if (hb.oneshot) {
                void this.fireOnce(entry).catch((err) => {
                    log.error({ name: hb.name, err }, 'One-shot heartbeat failed');
                });
            } else {
                entry.timer = setInterval(() => this.fire(entry), intervalMs);
                entry.timer.unref();
            }

            this.entries.set(hb.name, entry);
            log.info(
                { name: hb.name, interval: hb.interval, oneshot: !!hb.oneshot },
                'Heartbeat registered',
            );
        }
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

    async triggerNow(name: string, context?: Record<string, unknown>): Promise<boolean> {
        const entry = this.entries.get(name);
        if (!entry) return false;
        await this.fire(entry, context);
        return true;
    }

    private async fire(entry: HeartbeatEntry, context?: Record<string, unknown>): Promise<void> {
        const { definition: hb, defaultDelivery } = entry;

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

        const job: ExecutionJob = {
            id: `heartbeat-${hb.name}`,
            name: hb.name,
            trigger: 'heartbeat',
            prompt: hb.prompt,
            delivery: defaultDelivery,
            deliveryMode: hb.deliveryMode,
            context,
        };

        await this.executor.execute(job).catch((err) => {
            log.error({ name: hb.name, err }, 'Heartbeat execution failed');
        });
    }

    private async fireOnce(entry: HeartbeatEntry): Promise<void> {
        await this.fire(entry);
        entry.definition.enabled = false;
        log.info({ name: entry.definition.name }, 'One-shot heartbeat completed, disabled');
    }
}

function parseInterval(interval: string): number | null {
    const match = interval.match(/^(\d+)\s*(s|m|h|d)$/);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    switch (match[2]) {
        case 's':
            return value * 1_000;
        case 'm':
            return value * 60_000;
        case 'h':
            return value * 3_600_000;
        case 'd':
            return value * 86_400_000;
        default:
            return null;
    }
}
