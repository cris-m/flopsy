/**
 * Personality registry — loads `personalities.yaml`, validates entries, and
 * exposes them by name.
 *
 * A personality is a session-level VOICE OVERLAY appended after SOUL.md
 * when the user runs `/personality <name>`. The overlay persists for the
 * duration of the current session and resets on `/new` (because /new
 * opens a fresh session row whose `active_personality` is NULL).
 *
 * Discovery is one-shot at boot — the YAML file is loaded once, parsed,
 * validated, and held in a Map. Editing the file requires a gateway
 * restart (deliberate; matches how SOUL.md / AGENTS.md behave).
 */

import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { createLogger, resolveWorkspacePath } from '@flopsy/shared';

const log = createLogger('personalities');

/**
 * Each entry in `personalities.yaml` validates against this shape. The
 * key (top-level YAML map key) becomes the personality `name` after we
 * verify it matches our slug regex.
 */
const personalityEntrySchema = z.object({
    description: z.string().min(1).max(200),
    body: z.string().min(1).max(8000),
});

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export interface Personality {
    /** The personality's name — matches the slash command argument. */
    readonly name: string;
    /** One-line summary shown in `/personality` listings. */
    readonly description: string;
    /** Prompt overlay text — appended after SOUL.md when active. */
    readonly body: string;
}

export class PersonalityRegistry {
    private readonly map = new Map<string, Personality>();

    constructor(personalities: ReadonlyArray<Personality>) {
        for (const p of personalities) this.map.set(p.name, p);
    }

    /** Look up a personality by name. Returns null when not found. */
    get(name: string): Personality | null {
        return this.map.get(name) ?? null;
    }

    /** True iff a personality with this name exists. */
    has(name: string): boolean {
        return this.map.has(name);
    }

    /** Listing for the `/personality` UI — sorted alphabetically. */
    list(): ReadonlyArray<Personality> {
        return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    get size(): number {
        return this.map.size;
    }
}

/**
 * Inputs to `resolvePersonality`. Encodes the four knobs the factory's
 * SystemPromptFn pulls from at turn-build time. Made standalone so the
 * priority chain is unit-testable without spinning up a full harness.
 */
export interface PersonalityResolutionInput {
    role: 'main' | 'worker';
    /** Loaded registry; null/undefined → resolution always returns null. */
    registry?: PersonalityRegistry;
    /** Per-turn override (proactive fires set this via cfg.personality). */
    overrideName?: string;
    /** Session-bound durable value (sessions.active_personality column). */
    sessionPersonality?: string | null;
    /** Agent config fallback (def.defaultPersonality). */
    defaultPersonality?: string;
}

/**
 * Resolve the active personality for a turn. Priority order:
 *
 *   1. `overrideName` — proactive fires that pick a mode-specific voice.
 *      Wins over the user's session choice because it's fire-specific
 *      and short-lived.
 *   2. `sessionPersonality` — durable per-session value the user set
 *      with `/personality <name>`.
 *   3. `defaultPersonality` — agent-config fallback so fresh sessions
 *      aren't voice-less. Optional; agents that don't set it stay
 *      overlay-free.
 *   4. (none) — plain SOUL.md voice.
 *
 * Unknown names at any tier fall through to the next tier (rather than
 * suppressing all overlays). This lets `defaultPersonality` still apply
 * if a typoed `overrideName` is passed in.
 */
export function resolvePersonality(input: PersonalityResolutionInput): Personality | null {
    if (!input.registry || input.registry.size === 0) return null;

    if (input.overrideName) {
        const p = input.registry.get(input.overrideName);
        if (p) return p;
    }
    if (input.sessionPersonality) {
        const p = input.registry.get(input.sessionPersonality);
        if (p) return p;
    }
    if (input.defaultPersonality) {
        const p = input.registry.get(input.defaultPersonality);
        if (p) return p;
    }
    return null;
}

/**
 * Resolve `personalities.yaml`'s on-disk path. Lives in the user's
 * workspace alongside SOUL.md / AGENTS.md so users can edit it without
 * touching the source tree.
 *
 * The seeder (`seed-workspace.ts`) copies a starter file from
 * `src/team/templates/personalities.yaml` into the workspace on first
 * boot if missing.
 */
function resolveYamlPath(): string {
    return resolveWorkspacePath('personalities.yaml');
}

/**
 * Load personalities from disk. Never throws — invalid YAML or a missing
 * file returns an empty registry, with a WARN log so operators notice.
 *
 * Validation rules per entry:
 *   - top-level key must match `[a-z][a-z0-9_]*` (slash-command-friendly)
 *   - `description` and `body` required, both non-empty strings
 *   - body capped at 8KB (overflow gets warned + dropped to keep the
 *     system prompt bounded)
 */
export function loadPersonalities(yamlPath: string = resolveYamlPath()): PersonalityRegistry {
    if (!existsSync(yamlPath)) {
        log.warn({ yamlPath }, 'personalities.yaml not found; /personality will list nothing');
        return new PersonalityRegistry([]);
    }

    let raw: string;
    try {
        raw = readFileSync(yamlPath, 'utf-8');
    } catch (err) {
        log.warn({ yamlPath, err: (err as Error).message }, 'failed to read personalities.yaml');
        return new PersonalityRegistry([]);
    }

    let parsed: unknown;
    try {
        parsed = yaml.load(raw);
    } catch (err) {
        log.warn({ yamlPath, err: (err as Error).message }, 'personalities.yaml: invalid YAML');
        return new PersonalityRegistry([]);
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        log.warn({ yamlPath }, 'personalities.yaml: top-level must be a map');
        return new PersonalityRegistry([]);
    }

    const out: Personality[] = [];
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (!NAME_RE.test(name)) {
            log.warn({ name }, 'personality: name must be snake_case ASCII; skipping');
            continue;
        }
        const result = personalityEntrySchema.safeParse(entry);
        if (!result.success) {
            log.warn(
                { name, issues: result.error.issues.map((i) => i.message) },
                'personality: invalid entry; skipping',
            );
            continue;
        }
        out.push({
            name,
            description: result.data.description.trim(),
            body: result.data.body.trim(),
        });
    }

    log.info(
        { count: out.length, names: out.map((p) => p.name) },
        'personalities loaded',
    );
    return new PersonalityRegistry(out);
}
