import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '@flopsy/shared';

const log = createLogger('skill-usage-store');

export type SkillLifecycleState = 'proposed' | 'active' | 'stale' | 'archived';

export interface PendingSkillEdit {
    // Per-bullet keys appendLessonsToSkill filters on, so reverted bullets can't re-apply.
    fingerprints: string[];
    bullets: string[];
    appliedAt: number;
    baselineRate: number;
    baselineN: number;
}

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
    pending_edit?: PendingSkillEdit | null;
    // Fingerprints of reverted edits — never re-apply.
    rejected_edits?: string[];
}

const MAX_REJECTED_EDITS = 50;

export function lessonFingerprint(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').replace(/[`*_]/g, '').trim();
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

    view(name: string): void {
        this.mutate(name, (rec) => {
            rec.view_count += 1;
            rec.last_viewed_at = nowIso();
            if (rec.state === 'stale') rec.state = 'active';
        });
    }

    patch(name: string): void {
        this.mutate(name, (rec) => {
            rec.patch_count += 1;
            rec.last_patched_at = nowIso();
            if (rec.state === 'stale') rec.state = 'active';
        });
    }

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

    recordPendingEdit(name: string, edit: PendingSkillEdit): boolean {
        let started = false;
        this.mutate(name, (rec) => {
            if (rec.pending_edit) return; // serialize — one trial at a time
            rec.pending_edit = edit;
            started = true;
        });
        return started;
    }

    getPendingEdit(name: string): PendingSkillEdit | null {
        return this.get(name)?.pending_edit ?? null;
    }

    clearPendingEdit(name: string): void {
        this.mutate(name, (rec) => { rec.pending_edit = null; });
    }

    // Capped, newest-wins.
    addRejectedEdit(name: string, fingerprint: string): void {
        this.mutate(name, (rec) => {
            const list = (rec.rejected_edits ?? []).filter((f) => f !== fingerprint);
            list.push(fingerprint);
            rec.rejected_edits = list.slice(-MAX_REJECTED_EDITS);
        });
    }

    getRejectedEdits(name: string): string[] {
        return this.get(name)?.rejected_edits ?? [];
    }

    isRejected(name: string, fingerprint: string): boolean {
        return this.getRejectedEdits(name).includes(fingerprint);
    }

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
