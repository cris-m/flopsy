import { createLogger, resolveWorkspacePath } from '@flopsy/shared';
import { SqliteCheckpointStore } from 'flopsygraph';

const log = createLogger('proactive-reaper');

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const PROACTIVE_THREAD_PREFIX = 'proactive:';

export interface ProactiveReaperConfig {
    sweepIntervalMs?: number;
    retentionMs?: number;
    checkpointsDbPath?: string;
}

// Sweeps ephemeral `proactive:<jobId>:<timestamp>` threads when per-fire
// cleanup fails (crashes, aborts, network glitches).
export class ProactiveReaper {
    private readonly store: SqliteCheckpointStore;
    private readonly sweepIntervalMs: number;
    private readonly retentionMs: number;
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;

    constructor(config: ProactiveReaperConfig = {}) {
        this.sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
        this.retentionMs = config.retentionMs ?? DEFAULT_RETENTION_MS;
        const path = config.checkpointsDbPath ?? resolveWorkspacePath('state', 'checkpoints.db');
        // Own connection: WAL mode handles concurrent DELETEs without contending the team handler's writer.
        this.store = new SqliteCheckpointStore({ path });
    }

    // driveOwnTimer=false lets ProactiveEngine fold the sweep into its cron tick.
    start(opts: { driveOwnTimer?: boolean } = {}): void {
        if (this.running) return;
        this.running = true;
        void this.sweep();
        if (opts.driveOwnTimer !== false) {
            this.timer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
            this.timer.unref();
        }
        log.info(
            {
                sweepIntervalMs: this.sweepIntervalMs,
                retentionMs: this.retentionMs,
                ownTimer: opts.driveOwnTimer !== false,
            },
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
            // shutdown noise
        }
        log.info('proactive reaper stopped');
    }

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
