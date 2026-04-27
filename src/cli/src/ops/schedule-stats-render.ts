/**
 * Shared stats / fires / list renderers for the three per-kind schedule CLIs
 * (`flopsy heartbeat|cron|webhook`). Each kind supplies its own row-shaper so
 * the UX stays consistent while preserving kind-specific columns.
 */

import { agoLabel, truncate } from '@flopsy/shared';
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

// ── Shared list / show helpers ───────────────────────────────────────────

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

/** Render a schedule list with standard dot + source-tag columns. */
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
    const tableRows = all.map((r) => {
        const cfg = parseConfig(r);
        const dot = r.enabled ? tint.success('●') : dim('○');
        const source = r.createdByThread ? dim('(agent)') : dim('(config-seeded)');
        return [dot, ...opts.middleCells(r, cfg), source];
    });
    console.log(table(tableRows));
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
        console.log(bad('No proactive.db yet.'));
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
    return 'No proactive.db yet — the gateway has not started with proactive enabled.';
}
