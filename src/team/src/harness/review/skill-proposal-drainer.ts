import { readFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '@flopsy/shared';
import { writeSkillFile, appendLessonsToSkill } from './skill-writer';
import { slugifySkillName } from './skill-scanner';
import type { SkillSignal } from './skill-signal-detector';

const log = createLogger('skill-proposal-drainer');

const DEFAULT_MIN_CONFIDENCE = 0.75;
const MAX_LESSON_CHARS = 400;
const MAX_FILE_CHARS = 4_000_000;

export interface PersistedSignal extends SkillSignal {
    ts: number;
    threadId: string;
    turnNumber: number;
}

export interface DrainerOptions {
    readonly proposalsPath: string;
    readonly skillsPath: string;
    readonly skillsProposedPath: string;
    readonly minConfidence?: number;
}

export interface DrainerResult {
    created: string[];
    appended: string[];
    archived: number;
    skipped: number;
}

export async function drainSkillProposals(opts: DrainerOptions): Promise<DrainerResult> {
    const result: DrainerResult = { created: [], appended: [], archived: 0, skipped: 0 };
    const min = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

    if (!existsSync(opts.proposalsPath)) return result;

    let raw: string;
    try { raw = await readFile(opts.proposalsPath, 'utf8'); }
    catch (err) {
        log.warn({ err, path: opts.proposalsPath }, 'failed to read proposals JSONL');
        return result;
    }
    if (raw.length === 0) return result;
    if (raw.length > MAX_FILE_CHARS) {
        log.warn({ size: raw.length, max: MAX_FILE_CHARS, path: opts.proposalsPath }, 'proposals JSONL too large — skipping drain');
        return result;
    }

    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const signals: PersistedSignal[] = [];
    for (const line of lines) {
        try {
            const obj = JSON.parse(line) as PersistedSignal;
            if (typeof obj.confidence !== 'number' || obj.confidence < min) {
                result.skipped += 1;
                continue;
            }
            signals.push(obj);
        } catch {
            result.skipped += 1;
        }
    }
    result.archived = signals.length + result.skipped;

    if (signals.length === 0) {
        await archiveJsonl(opts.proposalsPath);
        return result;
    }

    const byNewSkill = new Map<string, PersistedSignal[]>();
    const byExistingSkill = new Map<string, PersistedSignal[]>();
    for (const s of signals) {
        if (s.suggested_existing_skill) {
            const key = slugifySkillName(s.suggested_existing_skill);
            const bucket = byExistingSkill.get(key) ?? [];
            bucket.push(s);
            byExistingSkill.set(key, bucket);
        } else if (s.suggested_skill_name) {
            const key = slugifySkillName(s.suggested_skill_name);
            const bucket = byNewSkill.get(key) ?? [];
            bucket.push(s);
            byNewSkill.set(key, bucket);
        } else {
            result.skipped += 1;
        }
    }

    for (const [name, bucket] of byNewSkill) {
        const body = renderProposedSkillFromSignals(name, bucket);
        try {
            const written = await writeSkillFile(opts.skillsProposedPath, name, body);
            if (written) {
                result.created.push(name);
                log.info({ name, signals: bucket.length }, 'drainer: wrote new proposed skill from signals');
            }
        } catch (err) {
            log.warn({ err, name }, 'drainer: writeSkillFile failed');
        }
    }

    for (const [name, bucket] of byExistingSkill) {
        const lessons = bucket
            .map((s) => truncate(s.summary, MAX_LESSON_CHARS))
            .filter((s, i, arr) => arr.indexOf(s) === i);
        try {
            const ok = await appendLessonsToSkill(opts.skillsPath, name, lessons);
            if (ok) {
                result.appended.push(name);
                log.info({ name, lessons: lessons.length }, 'drainer: appended lessons from signals');
            }
        } catch (err) {
            log.warn({ err, name }, 'drainer: appendLessonsToSkill failed');
        }
    }

    await archiveJsonl(opts.proposalsPath);
    return result;
}

async function archiveJsonl(path: string): Promise<void> {
    const archived = `${path}.processed-${Date.now()}.jsonl`;
    try {
        if (!existsSync(dirname(archived))) {
            await mkdir(dirname(archived), { recursive: true });
        }
        await rename(path, archived);
    } catch (err) {
        log.warn({ err, path, archived }, 'drainer: archive rename failed (file kept in place)');
    }
}

function renderProposedSkillFromSignals(name: string, signals: PersistedSignal[]): string {
    const sorted = [...signals].sort((a, b) => b.confidence - a.confidence);
    const primary = sorted[0]!;
    const evidenceLines = sorted.map(
        (s) =>
            `- (conf ${s.confidence.toFixed(2)}, ${s.signal_type}) ${truncate(s.summary, MAX_LESSON_CHARS)}`,
    );
    const frontmatter = [
        '---',
        `name: ${name}`,
        `description: ${truncate(primary.summary, 200)}`,
        `signal_type: ${primary.signal_type}`,
        `confidence: ${primary.confidence}`,
        `signals_count: ${signals.length}`,
        'source: skill-signal-detector',
        '---',
    ].join('\n');
    return `${frontmatter}\n\n# ${name}\n\n${primary.summary}\n\n## Evidence\n${evidenceLines.join('\n')}\n`;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

export const _internals = { renderProposedSkillFromSignals, archiveJsonl } as const;
