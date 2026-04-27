import { createLogger, resolveWorkspacePath } from '@flopsy/shared';
import { SqliteCheckpointStore } from 'flopsygraph';

const log = createLogger('proactive-reaper');

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;        // 5 min
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;        // 24 h
const PROACTIVE_THREAD_PREFIX = 'proactive:';

export interface ProactiveReaperConfig {
    /** How often to run the sweep. Default 5 min (matches OpenClaw). */
    sweepIntervalMs?: number;
    /** Drop ephemeral threads older than this. Default 24h. */
    retentionMs?: number;
    /** Override the checkpoints.db path (otherwise resolved from workspace). */
    checkpointsDbPath?: string;
}

/**
 * Reaper for ephemeral `proactive:<jobId>:<timestamp>` checkpoint threads.
 *
 * Each heartbeat / cron fire creates a one-shot thread to execute the agent
 * in isolation (so the user's chat history isn't polluted). Per-fire cleanup
 * is "best-effort"; when it fails (network glitch, agent crash, abort), the
 * thread row stays in checkpoints.db forever. Over weeks this accumulates.
 *
 * OpenClaw runs an equivalent `sweepCronRunSessions()` every 5 min, retention
 * 24h. We follow the same convention.
 */
export class ProactiveReaper {
    private readonly store: SqliteCheckpointStore;
    private readonly sweepIntervalMs: number;
    private readonly retentionMs: number;
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;

    constructor(config: ProactiveReaperConfig = {}) {
        this.sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
        this.retentionMs = config.retentionMs ?? DEFAULT_RETENTION_MS;
        const path = config.checkpointsDbPath ?? resolveWorkspacePath('harness', 'checkpoints.db');
        // Reaper opens its own connection — better-sqlite3 in WAL mode
        // handles multi-handle concurrency for short DELETEs without
        // contending the team handler's writer.
        this.store = new SqliteCheckpointStore({ path });
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        // Fire-and-forget initial sweep so a fresh start cleans any
        // accumulated cruft from prior runs that crashed before sweep.
        void this.sweep();
        this.timer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
        // unref so the reaper never holds the process alive on shutdown.
        this.timer.unref();
        log.info(
            { sweepIntervalMs: this.sweepIntervalMs, retentionMs: this.retentionMs },
            'proactive reaper started',
        );
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        try {
            this.store.close();
        } catch {
            // ignore — close-on-shutdown errors are noise
        }
        log.info('proactive reaper stopped');
    }

    /** Public for tests / CLI manual sweep. */
    async sweep(): Promise<number> {
        try {
            const deleted = await this.store.pruneByThreadPrefix(
                PROACTIVE_THREAD_PREFIX,
                this.retentionMs,
            );
            if (deleted > 0) {
                log.info({ deleted, prefix: PROACTIVE_THREAD_PREFIX }, 'reaped ephemeral threads');
            }
            return deleted;
        } catch (err) {
            log.warn({ err }, 'proactive reaper sweep failed');
            return 0;
        }
    }
}
