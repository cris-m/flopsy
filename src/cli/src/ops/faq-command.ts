import { Command } from 'commander';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';
import { accent, bad, dim, ok, section, table, warn } from '../ui/pretty';
import { readFlopsyConfig } from './config-reader';
import { resolveWorkspacePath, truncate } from '@flopsy/shared';

interface SessionRow {
    readonly summary: string | null;
    readonly opened_at: number;
}

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

const STOPWORDS = new Set([
    'what', 'when', 'where', 'which', 'with', 'have', 'this', 'that', 'from', 'about',
    'does', 'doing', 'should', 'would', 'could', 'will', 'wont', 'cant', 'isnt',
    'they', 'them', 'their', 'there', 'these', 'those', 'your', 'you', 'just',
    'flopsy', 'agent',
]);

export function registerFaqCommand(root: Command): void {
    root
        .command('faq')
        .description('Surface recurring questions from session summaries (deterministic, no LLM)')
        .option('--days <n>', 'Window in days', '30')
        .option('--min <n>', 'Minimum repetitions to surface', '2')
        .option('--limit <n>', 'Max rows', '20')
        .option('--json', 'Emit JSON')
        .action((opts: { days?: string; min?: string; limit?: string; json?: boolean }) => {
            readFlopsyConfig();
            const dbPath = resolveWorkspacePath('state', 'learning.db');
            if (!existsSync(dbPath)) {
                console.log(warn('learning.db not found — chat once for sessions to accumulate.'));
                return;
            }
            const days = Math.max(1, parseInt(opts.days ?? '30', 10) || 30);
            const min = Math.max(2, parseInt(opts.min ?? '2', 10) || 2);
            const limit = Math.max(1, Math.min(parseInt(opts.limit ?? '20', 10) || 20, 100));
            const since = Date.now() - days * 24 * 60 * 60 * 1000;
            const db = new Database(dbPath, { readonly: true });
            try {
                const rows = db
                    .prepare(
                        `SELECT summary, opened_at FROM sessions
                          WHERE summary IS NOT NULL AND opened_at >= ?
                          ORDER BY opened_at DESC`,
                    )
                    .all(since) as SessionRow[];
                if (rows.length === 0) {
                    console.log(section('FAQ'));
                    console.log(dim(`  No closed sessions in the last ${days}d. Open + /new a few times to accumulate data.`));
                    return;
                }

                const buckets = new Map<string, { count: number; sample: string; lastSeen: number }>();
                for (const r of rows) {
                    const lines = (r.summary ?? '').split(/\n+/);
                    for (const raw of lines) {
                        const trimmed = raw.trim();
                        if (!trimmed.endsWith('?')) continue;
                        if (trimmed.length < 12 || trimmed.length > 200) continue;
                        const norm = normalizeQuestion(trimmed);
                        const root = rootForm(norm);
                        if (root.length < 8) continue;
                        const prev = buckets.get(root);
                        if (prev) {
                            prev.count += 1;
                            if (r.opened_at > prev.lastSeen) prev.lastSeen = r.opened_at;
                        } else {
                            buckets.set(root, { count: 1, sample: trimmed, lastSeen: r.opened_at });
                        }
                    }
                }
                const findings = [...buckets.entries()]
                    .filter(([, v]) => v.count >= min)
                    .sort((a, b) => b[1].count - a[1].count)
                    .slice(0, limit);

                if (opts.json) {
                    console.log(JSON.stringify(findings.map(([root, v]) => ({ root, count: v.count, sample: v.sample, lastSeenMs: v.lastSeen })), null, 2));
                    return;
                }
                if (findings.length === 0) {
                    console.log(section('FAQ'));
                    console.log(dim(`  No question repeated ${min}+ times in the last ${days}d (scanned ${rows.length} sessions).`));
                    return;
                }
                console.log(section('Frequent questions') + '  ' + dim(`(${findings.length} groups · ${days}d window · scanned ${rows.length} sessions)`));
                console.log(
                    table([
                        ['count', 'sample question'],
                        ...findings.map(([, v]) => [accent(`×${v.count}`), truncate(v.sample, 80)]),
                    ]),
                );
                console.log();
                console.log(dim(`  Consider authoring a skill for the top groups — flopsy skill install ./<skill-dir>`));
            } catch (err) {
                console.log(bad(`faq failed: ${(err as Error).message}`));
            } finally {
                db.close();
            }
        });
}
