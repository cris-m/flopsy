/**
 * SkillUsageStore — sidecar provenance + lifecycle tracker for SKILL.md files.
 *
 * Persists to <skillsPath>/.skill-state.json — a flat JSON map keyed by skill
 * name. Atomic writes (tmp → rename) prevent partial reads. All mutations are
 * best-effort: failures log at debug and never break skill tool calls.
 *
 * Schema per entry:
 *   state            — 'proposed' | 'active' | 'stale' | 'archived'
 *   pinned           — curator skips auto-transitions when true
 *   is_agent_created — true when written via skill_manage(create)
 *   view_count       — bumped when agent reads SKILL.md via read_file
 *   patch_count      — bumped on skill_manage(append_lessons | bump_version)
 *   created_at       — ISO timestamp set on first write
 *   last_viewed_at   — ISO timestamp set on view()
 *   last_patched_at  — ISO timestamp set on patch()
 *   archived_at      — ISO timestamp set when state → archived
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '@flopsy/shared';

const log = createLogger('skill-usage-store');

export type SkillLifecycleState = 'proposed' | 'active' | 'stale' | 'archived';

export interface SkillUsageRecord {
    state: SkillLifecycleState;
    pinned: boolean;
    is_agent_created: boolean;
    view_count: number;
    patch_count: number;
    created_at: string;
    last_viewed_at: string | null;
    last_patched_at: string | null;
    archived_at: string | null;
}

type UsageMap = Record<string, SkillUsageRecord>;

function nowIso(): string {
    return new Date().toISOString();
}

function defaultRecord(): SkillUsageRecord {
    return {
        state: 'active',
        pinned: false,
        is_agent_created: false,
        view_count: 0,
        patch_count: 0,
        created_at: nowIso(),
        last_viewed_at: null,
        last_patched_at: null,
        archived_at: null,
    };
}

export class SkillUsageStore {
    readonly filePath: string;

    constructor(skillsPath: string) {
        this.filePath = join(skillsPath, '.skill-state.json');
    }

    // ── Read ─────────────────────────────────────────────────────────────────

    loadAll(): UsageMap {
        if (!existsSync(this.filePath)) return {};
        try {
            const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
            if (typeof data === 'object' && data !== null) return data as UsageMap;
        } catch (err) {
            log.debug({ err }, '.skill-state.json read failed');
        }
        return {};
    }

    get(name: string): SkillUsageRecord | null {
        return this.loadAll()[name] ?? null;
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    private mutate(name: string, fn: (rec: SkillUsageRecord) => void): void {
        try {
            const map = this.loadAll();
            const rec = map[name] ?? defaultRecord();
            fn(rec);
            map[name] = rec;
            this.flush(map);
        } catch (err) {
            log.debug({ name, err }, 'skill-state mutate failed (non-fatal)');
        }
    }

    private flush(map: UsageMap): void {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
        renameSync(tmp, this.filePath);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Called when the agent reads a SKILL.md via read_file. */
    view(name: string): void {
        this.mutate(name, (rec) => {
            rec.view_count += 1;
            rec.last_viewed_at = nowIso();
            // Re-activate stale skills the agent is actively viewing.
            if (rec.state === 'stale') rec.state = 'active';
        });
    }

    /** Called on skill_manage(append_lessons | bump_version). */
    patch(name: string): void {
        this.mutate(name, (rec) => {
            rec.patch_count += 1;
            rec.last_patched_at = nowIso();
            if (rec.state === 'stale') rec.state = 'active';
        });
    }

    /** Called on skill_manage(create) — opts the skill into curator management. */
    markAgentCreated(name: string): void {
        this.mutate(name, (rec) => {
            rec.is_agent_created = true;
            rec.state = 'active';
        });
    }

    setState(name: string, state: SkillLifecycleState): void {
        this.mutate(name, (rec) => {
            rec.state = state;
            if (state === 'archived') rec.archived_at = nowIso();
            else if (state === 'active') rec.archived_at = null;
        });
    }

    setPinned(name: string, pinned: boolean): void {
        this.mutate(name, (rec) => { rec.pinned = pinned; });
    }

    /** Remove telemetry for a deleted skill. */
    forget(name: string): void {
        try {
            const map = this.loadAll();
            if (name in map) {
                delete map[name];
                this.flush(map);
            }
        } catch (err) {
            log.debug({ name, err }, 'skill-state forget failed');
        }
    }
}
