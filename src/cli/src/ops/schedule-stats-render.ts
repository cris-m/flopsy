/**
 * Shared stats / fires / list renderers for the three per-kind schedule CLIs
 * (`flopsy heartbeat|cron|webhook`). Each kind supplies its own row-shaper so
 * the UX stays consistent while preserving kind-specific columns.
 */

import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { agoLabel, resolveWorkspacePath, truncate } from '@flopsy/shared';
import { bad, detail, dim, info, ok, row, section, table, warn } from '../ui/pretty';
import { tint } from '../ui/theme';
import {
    fetchFires,
    fetchProactiveStats,
    loadSchedulesOfKind,
    parseConfig,
    type RuntimeScheduleRow,
    type ScheduleKind,
} from './schedule-client';

/**
 * Per-schedule rolled-up stats from `proactive_decisions` (the persistent
 * record of every fire). Computed locally from learning.db so this works
 * even when the gateway is stopped.
 *
 * `firesByDay` is the last 7 days as `[delivered, suppressed]` pairs
 * keyed by ISO date, so renderers can show a sparkline if they want.
 */
interface FireStats {
    fires: number;
    delivered: number;
    suppressed: number;
    errored: number;
    lastFiredAt: number | null;
    lastDelivered: boolean | null;
    firesLast24h: number;
    deliveredLast24h: number;
}

const STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read per-job-id stats from learning.db's `proactive_decisions` table.
 * Returns a Map keyed by `job_id`; empty if the table doesn't exist yet
 * (e.g. fresh install before any fire happened).
 */
export function loadFireStats(): Map<string, FireStats> {
    const result = new Map<string, FireStats>();
    const dbPath = resolveWorkspacePath('state', 'learning.db');
    if (!existsSync(dbPath)) return result;

    const db = new Database(dbPath, { readonly: true });
    try {
        // Probe for the table — older installs (pre-this-session) won't
        // have it. Returning the empty Map lets the renderer fall through
        // to the simple list shape without crashing.
        const tableExists = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='proactive_decisions'",
            )
            .get();
        if (!tableExists) return result;

        const since = Date.now() - STATS_WINDOW_MS;
        const day24 = Date.now() - 24 * 60 * 60 * 1000;
        const rows = db
            .prepare(
                `SELECT job_id,
                        COUNT(*)                                                     AS fires,
                        SUM(CASE WHEN delivered = 1 THEN 1 ELSE 0 END)               AS delivered,
                        SUM(CASE WHEN delivered = 0 THEN 1 ELSE 0 END)               AS suppressed,
                        SUM(CASE WHEN delivered = 2 THEN 1 ELSE 0 END)               AS errored,
                        SUM(CASE WHEN fired_at >= ? THEN 1 ELSE 0 END)               AS fires_24h,
                        SUM(CASE WHEN fired_at >= ? AND delivered = 1 THEN 1 ELSE 0 END) AS delivered_24h,
                        MAX(fired_at)                                                AS last_fired_at
                 FROM   proactive_decisions
                 WHERE  fired_at >= ?
                 GROUP  BY job_id`,
            )
            .all(day24, day24, since) as Array<{
                job_id: string;
                fires: number;
                delivered: number;
                suppressed: number;
                errored: number;
                fires_24h: number;
                delivered_24h: number;
                last_fired_at: number;
            }>;

        // Second query: was the most-recent fire of each job delivered?
        // Needed for the green/red badge on the list view. Cheap because
        // we filter by job_id and pick the latest row.
        const lastDeliveredStmt = db.prepare(
            `SELECT delivered FROM proactive_decisions
             WHERE job_id = ?
             ORDER BY fired_at DESC LIMIT 1`,
        );

        for (const r of rows) {
            const last = lastDeliveredStmt.get(r.job_id) as { delivered: number } | undefined;
            result.set(r.job_id, {
                fires: r.fires,
                delivered: r.delivered,
                suppressed: r.suppressed,
                errored: r.errored,
                lastFiredAt: r.last_fired_at,
                lastDelivered: last ? last.delivered === 1 : null,
                firesLast24h: r.fires_24h,
                deliveredLast24h: r.delivered_24h,
            });
        }
    } finally {
        db.close();
    }
    return result;
}

/** Format helpers used by list renderers. */
export function formatLastFired(stats: FireStats | undefined): string {
    if (!stats || !stats.lastFiredAt) return dim('never');
    const ago = agoLabel(Date.now() - stats.lastFiredAt).replace(' ago', '');
    if (stats.lastDelivered === true) return tint.success(ago);
    if (stats.lastDelivered === false) return warn(ago);
    return dim(ago);
}

export function formatFireCounts(stats: FireStats | undefined): string {
    if (!stats || stats.fires === 0) return dim('0 fires');
    const parts: string[] = [];
    parts.push(`${stats.delivered}d`);
    parts.push(`${stats.suppressed}s`);
    if (stats.errored > 0) parts.push(bad(`${stats.errored}e`));
    return `${stats.fires} fires (${parts.join('/')})`;
}

export function formatLast24h(stats: FireStats | undefined): string {
    if (!stats || stats.firesLast24h === 0) return dim('—');
    return `${stats.deliveredLast24h}/${stats.firesLast24h} 24h`;
}

/**
 * Per-fire detail used by the `flopsy cron|heartbeat why <id>` CLI. Picks
 * the most-recent fire of the requested job and groups suppressions by
 * `silence_reason` over the 7-day window so operators can see at a glance
 * "the last fire happened at 07:00, was suppressed because of an empty
 * agent response; over the past week, 3 of these silenced for the same
 * reason, 1 for duplicate_recent."
 */
export interface LastFireDetail {
    firedAt: number;
    durationMs: number;
    delivered: 0 | 1 | 2;
    deliveryMode: 'always' | 'conditional' | 'silent';
    hasStructured: 0 | 1;
    category: string | null;
    silenceReason: string | null;
    /** Agent justification or executor-synthesized reason. Truncated to 500. */
    reason: string | null;
    messagePreview: string | null;
    messageLen: number;
    suppressionsLast7d: Array<{ silenceReason: string | null; count: number }>;
}

/**
 * Read the single most-recent row for `jobId` from `proactive_decisions`,
 * plus a GROUP BY breakdown of suppressions in the last 7 days. Returns
 * `null` when the table is missing or the job has never fired.
 *
 * Kept in this module so it shares the DB-path / table-probe pattern with
 * `loadFireStats` — no second connection, same read-only handle scope.
 */
export function loadLastFireDetail(jobId: string): LastFireDetail | null {
    const dbPath = resolveWorkspacePath('state', 'learning.db');
    if (!existsSync(dbPath)) return null;

    const db = new Database(dbPath, { readonly: true });
    try {
        const tableExists = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='proactive_decisions'",
            )
            .get();
        if (!tableExists) return null;

        const last = db
            .prepare(
                `SELECT fired_at, duration_ms, delivered, delivery_mode,
                        has_structured, category, silence_reason, reason,
                        message_preview, message_len
                 FROM   proactive_decisions
                 WHERE  job_id = ?
                 ORDER  BY fired_at DESC
                 LIMIT  1`,
            )
            .get(jobId) as
            | {
                  fired_at: number;
                  duration_ms: number;
                  delivered: 0 | 1 | 2;
                  delivery_mode: 'always' | 'conditional' | 'silent';
                  has_structured: 0 | 1;
                  category: string | null;
                  silence_reason: string | null;
                  reason: string | null;
                  message_preview: string | null;
                  message_len: number;
              }
            | undefined;
        if (!last) return null;

        const since = Date.now() - STATS_WINDOW_MS;
        const breakdown = db
            .prepare(
                `SELECT silence_reason, COUNT(*) AS count
                 FROM   proactive_decisions
                 WHERE  job_id = ? AND fired_at >= ? AND delivered = 0
                 GROUP  BY silence_reason
                 ORDER  BY count DESC`,
            )
            .all(jobId, since) as Array<{ silence_reason: string | null; count: number }>;

        return {
            firedAt: last.fired_at,
            durationMs: last.duration_ms,
            delivered: last.delivered,
            deliveryMode: last.delivery_mode,
            hasStructured: last.has_structured,
            category: last.category,
            silenceReason: last.silence_reason,
            reason: last.reason,
            messagePreview: last.message_preview,
            messageLen: last.message_len,
            suppressionsLast7d: breakdown.map((b) => ({
                silenceReason: b.silence_reason,
                count: b.count,
            })),
        };
    } finally {
        db.close();
    }
}

/**
 * Render `LastFireDetail` for the `flopsy cron|heartbeat why <id>` CLI.
 * Single function reused across both subcommands so the layout stays
 * consistent (last fire → result → reason → 7d breakdown).
 */
export function renderLastFireDetail(jobId: string, detail: LastFireDetail): void {
    const ago = agoLabel(Date.now() - detail.firedAt).replace(' ago', '');
    const when = new Date(detail.firedAt).toISOString();
    // `warn()` and `bad()` already prepend their own status glyph
    // (⚠ / ✖). Passing a string with another ⚠/✗ inside doubles the
    // icon ("⚠ ⚠ suppressed"). Pass clean text only.
    const resultText =
        detail.delivered === 1
            ? (detail.messageLen > 0 && detail.messageLen < 300 && !detail.hasStructured
                  ? warn('delivered (fallback / narration suspect)')
                  : tint.success('✓ delivered'))
            : detail.delivered === 2
              ? bad('error')
              : warn('suppressed');

    console.log(section(`Last fire — ${jobId}`));
    console.log(`  fired:        ${dim(when)}  ${dim(`(${ago})`)}`);
    console.log(`  result:       ${resultText}`);
    console.log(`  mode:         ${detail.deliveryMode}`);
    console.log(`  duration:     ${Math.round(detail.durationMs / 1000)}s`);
    if (detail.category) console.log(`  category:     ${detail.category}`);
    if (detail.silenceReason) console.log(`  silence_reason: ${detail.silenceReason}`);
    if (detail.reason) {
        const lines = detail.reason.match(/.{1,72}(\s|$)/g) ?? [detail.reason];
        console.log(`  reason:`);
        for (const line of lines) console.log(`    ${line.trim()}`);
    }
    if (detail.messagePreview && detail.delivered === 1) {
        console.log(`  preview:      ${truncate(detail.messagePreview, 120)}`);
    }

    if (detail.suppressionsLast7d.length === 0) {
        console.log();
        console.log(dim('  no suppressions in the last 7 days'));
        return;
    }
    console.log();
    console.log(section('Suppressions (7d)'));
    for (const s of detail.suppressionsLast7d) {
        const label = s.silenceReason ?? '(no reason recorded — pre-fix fire)';
        // Single warning glyph via warn(); pass the label as plain text.
        console.log(`  ${warn(String(label).padEnd(28))} × ${s.count}`);
    }
}

export async function renderStats(kind: ScheduleKind, id?: string): Promise<void> {
    const stats = await fetchProactiveStats();
    if (!stats) {
        console.log(bad('Could not fetch proactive stats (gateway down?).'));
        process.exit(1);
    }
    const rows = stats.perSchedule.filter((s) => s.kind === kind);
    if (rows.length === 0) {
        console.log(dim(`No ${kind} schedules.`));
        return;
    }

    if (id) {
        const r = rows.find((s) => s.id === id);
        if (!r) {
            console.log(bad(`No ${kind} with id "${id}".`));
            console.log(info(`Run \`flopsy ${kind} stats\` (no id) to see all.`));
            process.exit(1);
        }
        console.log(section(`Stats: ${r.name}`));
        console.log(detail('id', r.id));
        console.log(detail('enabled', r.enabled ? 'yes' : 'no'));
        console.log(detail('runs', String(r.runCount)));
        console.log(detail('delivered', String(r.deliveredCount)));
        console.log(detail('suppressed', String(r.suppressedCount)));
        console.log(detail('queued', String(r.queuedCount)));
        console.log(detail('consecutive errors', String(r.consecutiveErrors)));
        if (r.lastRunAt)
            console.log(detail('last run', new Date(r.lastRunAt).toISOString()));
        if (r.lastStatus) console.log(detail('last status', r.lastStatus));
        if (r.lastAction) console.log(detail('last action', r.lastAction));
        if (r.lastError) console.log(detail('last error', warn(r.lastError)));
        console.log(
            detail('24h', `${tint.success(String(r.deliveredInWindow))} delivered`),
        );
        return;
    }

    const title = `${kind[0]!.toUpperCase()}${kind.slice(1)} stats`;
    console.log(
        section(
            `${title}  · 24h delivered: ${stats.aggregate.delivered} · retry queue: ${stats.aggregate.retryQueueDepth}`,
        ),
    );
    const tableRows = rows.map((r) => {
        const dot = r.enabled ? tint.success('●') : dim('○');
        const tag =
            r.consecutiveErrors > 0
                ? bad(`err×${r.consecutiveErrors}`)
                : (r.lastAction ?? '—');
        return [
            dot,
            r.name,
            dim(r.id),
            `${r.deliveredCount}d/${r.runCount}r`,
            `${r.deliveredInWindow} in 24h`,
            dim(tag),
        ];
    });
    console.log(table(tableRows));
}

export async function renderFires(id: string, limit: number): Promise<void> {
    const rows = await fetchFires(id, limit);
    if (rows.length === 0) {
        console.log(dim(`No recorded fires for "${id}".`));
        console.log(info('New schedules have no history until they deliver.'));
        return;
    }
    console.log(section(`Fires for ${id}  (newest first, ${rows.length} rows)`));
    const now = Date.now();
    for (const r of rows) {
        const ago = agoLabel(now - r.deliveredAt).replace(' ago', '');
        const when = new Date(r.deliveredAt).toISOString();
        console.log(`  ${ok('●')} ${dim(when)}  ${dim(`(${ago})`)}`);
        console.log(`    ${truncate(r.content, 140)}`);
    }
}

export interface ListOptions {
    /** Section header (e.g. "Heartbeats"). */
    readonly title: string;
    /** Empty-state row label (e.g. "heartbeats"). */
    readonly emptyLabel: string;
    /** Hint command for empty state (e.g. "flopsy heartbeat add --help"). */
    readonly addHint: string;
    /** Per-row cells after the status dot — excludes dot + source tag. */
    readonly middleCells: (r: RuntimeScheduleRow, cfg: Record<string, unknown>) => string[];
}

/** Render a schedule list with standard dot + source-tag columns.
 *
 * Per-schedule fire stats are joined from `learning.db.proactive_decisions`
 * (the persistent log of every fire, recorded by JobExecutor.finalize()).
 * When the table doesn't exist (pre-this-session installs), the columns
 * simply show "never" / "0 fires" / "—". The trailing columns appear AFTER
 * the kind-specific middle cells so each renderer keeps its existing
 * column shape and gets observability for free.
 */
export function renderScheduleList(kind: ScheduleKind, opts: ListOptions): void {
    const all = loadSchedulesOfKind(kind);
    if (all === null) {
        console.log(dim(noDbHint()));
        return;
    }
    console.log(section(opts.title));
    if (all.length === 0) {
        console.log(row(opts.emptyLabel, dim(`none — \`${opts.addHint}\``)));
        return;
    }
    // Pull per-schedule fire stats once for the whole table — cheap; one
    // grouped SELECT against learning.db rather than per-row queries.
    const fireStats = loadFireStats();

    const tableRows = all.map((r) => {
        const cfg = parseConfig(r);
        const dot = r.enabled ? tint.success('●') : dim('○');
        const stats = fireStats.get(r.id);
        // Surface oneshot flag inline — important context the list was
        // previously missing. Lives in different config locations per
        // kind: top-level for heartbeats, under `payload` for cron.
        const payload = (cfg['payload'] ?? {}) as Record<string, unknown>;
        const isOneshot =
            cfg['oneshot'] === true || payload['oneshot'] === true;
        const oneshotTag = isOneshot ? dim('· 1-shot') : '';
        const source = r.createdByThread ? dim('(agent)') : dim('(config-seeded)');
        return [
            dot,
            ...opts.middleCells(r, cfg),
            formatLastFired(stats),
            formatFireCounts(stats),
            formatLast24h(stats),
            oneshotTag,
            source,
        ];
    });
    console.log(table(tableRows));
    // Footer legend so the count syntax is decodable without docs.
    console.log('');
    console.log(
        dim(
            '  ● enabled · ○ disabled · last-fired colored: green=delivered, yellow=suppressed · fires (delivered d / suppressed s / errored e) · 24h: delivered/total',
        ),
    );
}

export interface ShowOptions {
    /** Singular label for the missing-id error ("heartbeat", "cron job", …). */
    readonly label: string;
    /** Command users should re-run to find ids ("flopsy heartbeat list", …). */
    readonly listCmd: string;
    /** Derive the section-header name from the schedule row + parsed config. */
    readonly nameOf: (r: RuntimeScheduleRow, cfg: Record<string, unknown>) => string;
    /** Emit per-kind detail rows after the shared id/header block. */
    readonly renderDetails: (r: RuntimeScheduleRow, cfg: Record<string, unknown>) => void;
}

/** Resolve + render a single schedule row with the shared header/footer
 * scaffolding. Exits non-zero when the id isn't found. */
export function renderScheduleShow(kind: ScheduleKind, id: string, opts: ShowOptions): void {
    const all = loadSchedulesOfKind(kind);
    if (all === null) {
        console.log(bad('No schedules store yet (learning.db absent — start the gateway with proactive enabled).'));
        process.exit(1);
    }
    const r = all.find((x) => x.id === id);
    if (!r) {
        console.log(bad(`No ${opts.label} with id "${id}".`));
        console.log(info(`Run \`${opts.listCmd}\` to see available ids.`));
        process.exit(1);
    }
    const cfg = parseConfig(r);
    const name = opts.nameOf(r, cfg);
    const headerAccent = r.enabled ? 'success' : 'muted';
    console.log(section(`${cap(opts.label)}: ${name}`, headerAccent));
    console.log(
        `  ${r.enabled ? tint.success('●') : dim('○')} ${name}  ${dim(r.enabled ? 'enabled' : 'disabled')}`,
    );
    console.log(detail('id', r.id));
    opts.renderDetails(r, cfg);
    console.log(detail('created', new Date(r.createdAt).toISOString()));
    if (r.createdByThread) console.log(detail('createdBy', r.createdByThread));
}

function cap(s: string): string {
    return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function noDbHint(): string {
    return 'No schedules store yet — the gateway has not started with proactive enabled (schedules live in learning.db).';
}
