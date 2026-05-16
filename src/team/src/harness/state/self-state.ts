/**
 * `<self_state>` block builder — surfaces the agent's own skill-catalog
 * telemetry to itself.
 *
 * Why this exists: the agent is excellent at task execution but blind to its
 * own systemic state. It thinks the self-improvement loop is running because
 * its prompt knowledge says it has `skill_manage(create, ...)` — but the data
 * (patch_count = 0 across the entire catalog) says otherwise. Without a
 * telemetry feed, the agent will confidently describe the *intended* loop
 * when asked "are you learning?" instead of the *actual* state.
 *
 * This helper reads `<skillsPath>/.skill-state.json` (written by SkillUsageStore)
 * and renders an XML-flavoured block that fits alongside `<last_session>`,
 * `<tool_quirks>` etc. in the existing harness. The block also surfaces
 * **warnings** — explicit "no agent-created skills exist" notices — so
 * when the agent is asked about its self-improvement progress it has the
 * honest answer in hand.
 *
 * Pure function, read-only, idempotent: callers can include the result in
 * a cached frozen snapshot without side effects.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL_STATE_FILE = '.skill-state.json';
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type SkillLifecycleState = 'proposed' | 'active' | 'stale' | 'archived';

interface SkillRecord {
    state?: SkillLifecycleState;
    pinned?: boolean;
    is_agent_created?: boolean;
    view_count?: number;
    patch_count?: number;
    last_viewed_at?: string | null;
    last_patched_at?: string | null;
    created_at?: string;
}

interface SelfStateMetrics {
    total: number;
    agentCreated: number;
    pinned: number;
    byState: Record<SkillLifecycleState, number>;
    patchedInWindow: number;
    viewedInWindow: number;
    mostUsed: { name: string; views: number } | null;
}

/**
 * Build the `<self_state>` block. Returns an empty string when the state
 * file is missing, unreadable, or empty — callers should treat empty as
 * "skip this section," same convention as the other harness builders.
 */
export function buildSelfStateBlock(
    skillsPath: string,
    windowMs: number = DEFAULT_WINDOW_MS,
): string {
    const file = join(skillsPath, SKILL_STATE_FILE);
    if (!existsSync(file)) return '';

    let map: Record<string, SkillRecord>;
    try {
        const raw = readFileSync(file, 'utf-8');
        map = JSON.parse(raw) as Record<string, SkillRecord>;
    } catch {
        return '';
    }

    const records = Object.entries(map);
    if (records.length === 0) return '';

    const metrics = computeMetrics(records, windowMs);
    return renderSelfState(metrics, windowMs);
}

function computeMetrics(
    records: ReadonlyArray<[string, SkillRecord]>,
    windowMs: number,
): SelfStateMetrics {
    const now = Date.now();
    const since = now - windowMs;
    const m: SelfStateMetrics = {
        total: records.length,
        agentCreated: 0,
        pinned: 0,
        byState: { proposed: 0, active: 0, stale: 0, archived: 0 },
        patchedInWindow: 0,
        viewedInWindow: 0,
        mostUsed: null,
    };

    let topViews = -1;
    for (const [name, rec] of records) {
        if (rec.is_agent_created) m.agentCreated += 1;
        if (rec.pinned) m.pinned += 1;
        const state = (rec.state ?? 'active') as SkillLifecycleState;
        m.byState[state] = (m.byState[state] ?? 0) + 1;
        if (rec.last_patched_at && Date.parse(rec.last_patched_at) >= since) m.patchedInWindow += 1;
        if (rec.last_viewed_at && Date.parse(rec.last_viewed_at) >= since) m.viewedInWindow += 1;
        const views = rec.view_count ?? 0;
        if (views > topViews) {
            topViews = views;
            m.mostUsed = { name, views };
        }
    }
    return m;
}

function renderSelfState(m: SelfStateMetrics, windowMs: number): string {
    const windowDays = Math.round(windowMs / (24 * 60 * 60 * 1000));
    const lines: string[] = [];

    // Description framing matters: the agent will use this block to answer
    // meta-questions about its own state. Tell it explicitly what this is.
    lines.push(
        `<self_state description="Telemetry about your own skill catalog and self-improvement loop. When the user asks 'are you learning', 'what have you created', 'have you patched any skills', 'is the catalog growing' — answer from THIS block, not from your general prompt knowledge of what the loop is supposed to do." window="${windowDays}d">`,
    );
    lines.push(
        `  skills: ${m.total} total · ${m.agentCreated} agent_created · ${m.pinned} pinned`,
    );
    lines.push(
        `  by_state: active=${m.byState.active}, stale=${m.byState.stale}, archived=${m.byState.archived}, proposed=${m.byState.proposed}`,
    );
    lines.push(
        `  activity_in_window: ${m.viewedInWindow} viewed, ${m.patchedInWindow} patched`,
    );
    if (m.mostUsed) {
        lines.push(`  most_used: ${m.mostUsed.name} (${m.mostUsed.views} views)`);
    }

    // Surface systemic issues explicitly. Without these, the agent reads the
    // numeric counts and may not connect them to "the loop is broken." With
    // the warnings, it has the honest answer in plain words.
    const warnings: string[] = [];
    if (m.agentCreated === 0 && m.total > 0) {
        warnings.push(
            'No agent-created skills exist. The self-improvement loop has NOT produced any new skills. ' +
                'If asked "are you learning?" answer truthfully — patches and lessons may be flowing, but skill creation has never fired.',
        );
    }
    if (m.patchedInWindow === 0 && m.total > 0) {
        warnings.push(
            `Zero skills patched in the last ${windowDays} days. skill_manage(append_lessons | bump_version) ` +
                `is either not being called or not being recorded. The self-improve heartbeat may be writing lessons without ` +
                `the usage store seeing it (known plumbing gap).`,
        );
    }
    if (warnings.length > 0) {
        lines.push('  warnings:');
        for (const w of warnings) lines.push(`    - ${w}`);
    }

    lines.push('</self_state>');
    return lines.join('\n');
}
