/**
 * Tiny YAML-frontmatter reader for `--prompt-file <path>` paths supplied to
 * `flopsy cron add` and `flopsy heartbeat add`.
 *
 * Why this exists: the runtime layer in `executor.ts` already resolves
 * `job.payload.skills` / `hb.skills` into preloaded `<active_skills>` blocks,
 * but the *creation* surface (CLI + mgmt API) was never wired to read
 * `skills:` from the file's YAML header. So a user can't say
 * "this cron always loads daily-rhythm" by declaring it in the prompt file —
 * they have to remember to pass `--skill daily-rhythm` on the command line
 * every time. Mirroring `personalities.yaml`'s loader pattern: load + parse
 * YAML + soft-validate. Anything unparseable returns `{}` rather than
 * throwing — the user's --skill flags still work, they just don't get the
 * frontmatter merged in.
 */

import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';

export interface PromptFrontmatter {
    /** Skills declared in the YAML header of the prompt file. */
    skills?: string[];
}

/**
 * Read frontmatter block from a markdown/text file. Returns `{}` on any
 * failure (missing file, no frontmatter, malformed YAML, wrong types). The
 * caller decides how to merge with command-line flags.
 */
export function readPromptFrontmatter(filePath: string): PromptFrontmatter {
    let raw: string;
    try {
        raw = readFileSync(filePath, 'utf8');
    } catch {
        return {};
    }

    // Frontmatter must be the very first thing in the file. Anything else
    // (a blank line, BOM, prose) means there's no header and we skip.
    if (!raw.startsWith('---')) return {};

    // The header is bounded by a leading `---\n` and a trailing `---` on its
    // own line. We slice between them — anything more lenient causes false
    // matches on horizontal rules later in the body.
    const endMarker = raw.indexOf('\n---', 4);
    if (endMarker === -1) return {};
    const yamlSlice = raw.slice(4, endMarker).trim();
    if (!yamlSlice) return {};

    let parsed: unknown;
    try {
        parsed = yaml.load(yamlSlice);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object') return {};

    const obj = parsed as Record<string, unknown>;
    const out: PromptFrontmatter = {};

    if (Array.isArray(obj['skills'])) {
        const cleaned = (obj['skills'] as unknown[])
            .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
            .map((x) => x.trim());
        if (cleaned.length > 0) out.skills = cleaned;
    }

    return out;
}

/**
 * Merge `skills` from the prompt file's frontmatter with skills supplied on
 * the command line. Union with stable order: frontmatter first (since the
 * file declares the *intrinsic* skills of the prompt), then any CLI flags
 * the user added on top. Duplicates removed, original order preserved.
 */
export function mergeSkills(
    frontmatterSkills: string[] | undefined,
    cliSkills: string[] | undefined,
): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const list of [frontmatterSkills ?? [], cliSkills ?? []]) {
        for (const name of list) {
            const trimmed = name.trim();
            if (!trimmed || seen.has(trimmed)) continue;
            seen.add(trimmed);
            out.push(trimmed);
        }
    }
    return out;
}
