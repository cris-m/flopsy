/**
 * `<faq_recurring>` block builder.
 *
 * Surfaces recurring user questions from session summaries to the dreaming
 * heartbeat. The dreaming prompt acts on these signals — recurring patterns
 * become candidates for USER.md additions, MEMORY.md project facts, or
 * skill_manage(create) when the recurrence shows a procedural shape.
 *
 * Mechanism (mirrors `flopsy faq` CLI subcommand, but in-process):
 *   - Read learning.db.sessions.summary for the peer over a time window
 *   - Normalize each summary's first sentence → "root form" (lowercase,
 *     stopwords stripped, words sorted)
 *   - Group + count
 *   - Filter to entries with count ≥ MIN_REPETITIONS
 *   - Format as <faq_recurring> block with each pattern + example summaries
 *
 * Returns the empty string when:
 *   - The DB is missing
 *   - The peer has < MIN_REPETITIONS recurring patterns over the window
 *
 * The dreaming prompt is responsible for deciding what to DO with each
 * pattern (memory write vs skill creation vs no-op).
 */

import { existsSync } from 'node:fs';
import { createLogger, resolveWorkspacePath } from '@flopsy/shared';

const log = createLogger('proactive-faq-block');

const MIN_REPETITIONS = 2;
const MAX_PATTERNS = 8;
const MAX_EXAMPLE_LEN = 80;

const STOPWORDS = new Set([
    'what', 'when', 'where', 'which', 'with', 'have', 'this', 'that', 'from', 'about',
    'does', 'doing', 'should', 'would', 'could', 'will', 'wont', 'cant', 'isnt',
    'they', 'them', 'their', 'there', 'these', 'those', 'your', 'you', 'just',
    'flopsy', 'agent', 'asked', 'wants', 'want', 'help',
]);

function normalizeQuestion(line: string): string {
    return line
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function rootForm(q: string): string {
    const words = q.split(' ').filter((w) => w.length > 3 && !STOPWORDS.has(w));
    return words.slice(0, 6).sort().join(' ');
}

interface PatternRow {
    root: string;
    count: number;
    example: string;
    lastAt: number;
}

/**
 * Build the `<faq_recurring>` block for the dreaming heartbeat. Returns ''
 * when nothing surfaces (no DB, no sessions, or no patterns meet threshold).
 */
export function buildFaqBlock(peerId: string, windowMs: number): string {
    let Database: typeof import('better-sqlite3');
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        Database = require('better-sqlite3') as typeof import('better-sqlite3');
    } catch {
        return '';
    }

    const dbPath = resolveWorkspacePath('state', 'learning.db');
    if (!existsSync(dbPath)) return '';

    const sinceMs = Date.now() - windowMs;
    let rows: ReadonlyArray<{ summary: string | null; opened_at: number }>;
    try {
        const db = new Database(dbPath, { readonly: true });
        try {
            rows = db
                .prepare(
                    'SELECT summary, opened_at FROM sessions WHERE peer_id = ? AND opened_at >= ? AND summary IS NOT NULL ORDER BY opened_at DESC',
                )
                .all(peerId, sinceMs) as Array<{ summary: string | null; opened_at: number }>;
        } finally {
            db.close();
        }
    } catch (err) {
        log.debug(
            { err: err instanceof Error ? err.message : String(err), peerId },
            'faq-block: query failed; returning empty block',
        );
        return '';
    }

    if (rows.length === 0) return '';

    // Group by root form
    const groups = new Map<string, PatternRow>();
    for (const r of rows) {
        if (!r.summary) continue;
        const firstLine = r.summary.split('\n')[0]!.trim();
        if (firstLine.length < 5) continue;
        const root = rootForm(normalizeQuestion(firstLine));
        if (root.length < 4) continue;
        const existing = groups.get(root);
        if (existing) {
            existing.count += 1;
            // Keep the most recent example
            if (r.opened_at > existing.lastAt) {
                existing.example = firstLine.slice(0, MAX_EXAMPLE_LEN);
                existing.lastAt = r.opened_at;
            }
        } else {
            groups.set(root, {
                root,
                count: 1,
                example: firstLine.slice(0, MAX_EXAMPLE_LEN),
                lastAt: r.opened_at,
            });
        }
    }

    const patterns = [...groups.values()]
        .filter((p) => p.count >= MIN_REPETITIONS)
        .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
        .slice(0, MAX_PATTERNS);

    if (patterns.length === 0) return '';

    const days = Math.round(windowMs / 86_400_000);
    const lines: string[] = [];
    lines.push(`<faq_recurring window="${days}d" min_count="${MIN_REPETITIONS}">`);
    lines.push(`  ${patterns.length} recurring topic${patterns.length === 1 ? '' : 's'} across ${rows.length} sessions:`);
    for (const p of patterns) {
        lines.push(`    × ${p.count}: "${p.example}"`);
    }
    lines.push('</faq_recurring>');
    return lines.join('\n');
}
