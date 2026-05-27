import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { workspace, panel, row, STATE } from '@flopsy/shared';
import type { CommandDef, CommandContext } from '../types';
import { getSessionFacade } from '../session-facade';

interface SkillRef {
    name: string;
    description: string;
    skillFile: string;
}

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const SAFE_CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Resolve a skill name → its SKILL.md path. Walks BOTH layouts:
 *   - Flat (legacy):  <root>/<name>/SKILL.md
 *   - Grouped (new):  <root>/<group>/<name>/SKILL.md
 * Returns the path or null when not found.
 */
function findSkillMd(root: string, name: string): string | null {
    const flat = join(root, name, 'SKILL.md');
    if (existsSync(flat)) return flat;
    let groups: string[];
    try {
        groups = readdirSync(root);
    } catch {
        return null;
    }
    for (const group of groups) {
        const groupPath = join(root, group);
        try {
            if (!statSync(groupPath).isDirectory()) continue;
        } catch {
            continue;
        }
        const candidate = join(groupPath, name, 'SKILL.md');
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/** Resolve a skill name → its directory (parent of SKILL.md). Walks both layouts. */
function findSkillDir(root: string, name: string): string | null {
    const skillMd = findSkillMd(root, name);
    return skillMd ? skillMd.replace(/\/SKILL\.md$/, '') : null;
}

export const skillsCommand: CommandDef = {
    name: 'skills',
    description: 'Review skill proposals. `/skills`, `/skills approve <name>`, `/skills reject <name>`.',
    // Admin: approve/reject mutate the workspace (rename/rm under
    // <FLOPSY_HOME>/content/skills/). Even read verbs (list/show)
    // disclose what's been proposed — useful recon for a paired
    // adversary. Single-operator default: admin-only across the board.
    scope: 'admin',
    handler: async (ctx: CommandContext) => {
        const sub = (ctx.args[0] ?? '').toLowerCase();
        const target = ctx.args[1] ?? '';

        const skillsRoot = workspace.skills();
        const proposedRoot = workspace.skillsProposed();

        switch (sub) {
            case '':
            case 'list':
                return { text: renderList(skillsRoot, proposedRoot) };

            case 'proposed':
            case 'pending':
            case 'review':
                return { text: renderProposedList(proposedRoot) };

            case 'approve':
            case 'accept': {
                if (!target) return usage('approve');
                return { text: handleApprove(skillsRoot, proposedRoot, target) };
            }

            case 'reject':
            case 'discard':
            case 'delete': {
                if (!target) return usage('reject');
                return { text: handleReject(proposedRoot, target) };
            }

            case 'show':
            case 'preview':
            case 'view': {
                if (!target) return usage('show');
                return { text: handleShow(skillsRoot, proposedRoot, target) };
            }

            case 'propose':
            case 'extract':
            case 'capture': {
                return { text: await handlePropose(ctx.threadId) };
            }

            default:
                return usage(sub);
        }
    },
};

/**
 * Run the session-extractor on the peer's current session and report the
 * proposed skill. Auto-promotes at confidence ≥ 0.8 (writes to skills/);
 * lower confidence lands in skills-proposed/ for review via `/skills approve`.
 */
async function handlePropose(rawKey: string): Promise<string> {
    const facade = getSessionFacade();
    if (!facade?.proposeSkillFromCurrentSession) {
        return panel(
            [{ title: 'skill propose', lines: [
                row('status', `${STATE.warn}  facade not wired (no team handler)`, 12),
            ] }],
            { header: 'SKILLS' },
        );
    }
    const result = await facade.proposeSkillFromCurrentSession(rawKey);
    if (!result.proposed) {
        return panel(
            [{ title: 'skill propose', lines: [
                row('result', `${STATE.warn}  ${result.reason ?? 'no skill proposed'}`, 12),
            ] }],
            { header: 'SKILLS' },
        );
    }
    const verdict = result.autoActivated
        ? `${STATE.ok}  AUTO-ACTIVATED (confidence ${result.confidence?.toFixed(2)})`
        : `${STATE.warn}  parked for review (confidence ${result.confidence?.toFixed(2)}, below 0.8)`;
    return panel(
        [
            { title: 'skill propose', lines: [
                row('name',          result.name ?? '', 14),
                row('description',   (result.description ?? '').slice(0, 70), 14),
                row('confidence',    `${result.confidence?.toFixed(2) ?? '?'}`, 14),
                row('verdict',       verdict, 14),
                row('written to',    result.writtenPath ?? '', 14),
            ] },
            ...(result.when_to_use ? [{ title: 'when to use', lines: [row('', result.when_to_use, 0)] }] : []),
        ],
        { header: 'SKILLS' },
    );
}

function renderList(skillsRoot: string, proposedRoot: string): string {
    const active = listSkillRefs(skillsRoot);
    const proposed = listSkillRefs(proposedRoot);
    const sections = [
        {
            title: `proposed (${proposed.length})`,
            lines: proposed.length === 0
                ? [row('—', 'no pending proposals', 18)]
                : proposed.slice(0, 20).map((s) => row(s.name, truncate(s.description, 60), 18)),
        },
        {
            title: `active (${active.length})`,
            lines: active.length === 0
                ? [row('—', 'no skills installed', 18)]
                : active.slice(0, 30).map((s) => row(s.name, truncate(s.description, 60), 18)),
        },
    ];
    if (proposed.length > 20 || active.length > 30) {
        sections.push({
            title: 'note',
            lines: [row('list truncated', 'use /skills proposed for the full pending list', 18)],
        });
    }
    return panel(sections, { header: 'skills' });
}

function renderProposedList(proposedRoot: string): string {
    const proposed = listSkillRefs(proposedRoot);
    if (proposed.length === 0) {
        return oneLine('skills', `${STATE.off}  no pending proposals`);
    }
    const lines = proposed.map((s) => row(s.name, truncate(s.description, 70), 22));
    return panel(
        [
            { title: `proposed (${proposed.length})`, lines },
            {
                title: 'next',
                lines: [
                    row('/skills show <name>', 'preview body', 22),
                    row('/skills approve <name>', 'activate', 22),
                    row('/skills reject <name>', 'discard', 22),
                ],
            },
        ],
        { header: 'skills · proposed' },
    );
}

function handleApprove(skillsRoot: string, proposedRoot: string, rawName: string): string {
    const name = rawName.trim().toLowerCase();
    if (!SAFE_NAME_RE.test(name)) {
        return oneLine('skills', `${STATE.warn}  invalid skill name "${rawName}"`);
    }
    // Walks both flat and grouped layouts in proposed root.
    const src = findSkillDir(proposedRoot, name);
    if (!src) {
        return oneLine('skills', `${STATE.warn}  no proposed skill "${name}" — try /skills proposed`);
    }
    // Route the active destination by category from frontmatter — keeps
    // approved skills in the right group rather than dumping them flat.
    let category: string | null = null;
    try {
        const fm = readFileSync(join(src, 'SKILL.md'), 'utf-8').match(/^---\s*\n([\s\S]*?)\n---/);
        const m = fm?.[1]?.match(/^category:\s*(.+)$/m);
        if (m?.[1]) {
            const c = m[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
            if (SAFE_CATEGORY_RE.test(c)) category = c;
        }
    } catch { /* fall through to flat */ }
    const dest = category
        ? join(skillsRoot, category, name)
        : join(skillsRoot, name);
    // Refuse to clobber an existing active skill at the chosen destination.
    if (existsSync(dest) || findSkillDir(skillsRoot, name)) {
        return oneLine('skills', `${STATE.warn}  "${name}" already exists in active skills — reject the proposal or rename it manually`);
    }
    try {
        const { mkdirSync } = require('fs') as typeof import('fs');
        if (category) mkdirSync(join(skillsRoot, category), { recursive: true });
        renameSync(src, dest);
    } catch (err) {
        return oneLine('skills', `${STATE.warn}  could not promote "${name}": ${(err as Error).message}`);
    }
    return panel(
        [
            {
                title: 'approved',
                lines: [
                    row(name, `moved to ${category ?? '<flat>'}/${name}`, 22),
                    row('next', 'restart gateway or wait for hot-reload', 22),
                ],
            },
        ],
        { header: `skills · approve ${name}` },
    );
}

function handleReject(proposedRoot: string, rawName: string): string {
    const name = rawName.trim().toLowerCase();
    if (!SAFE_NAME_RE.test(name)) {
        return oneLine('skills', `${STATE.warn}  invalid skill name "${rawName}"`);
    }
    const target = findSkillDir(proposedRoot, name);
    if (!target) {
        return oneLine('skills', `${STATE.warn}  no proposed skill "${name}"`);
    }
    try {
        rmSync(target, { recursive: true, force: true });
    } catch (err) {
        return oneLine('skills', `${STATE.warn}  could not remove "${name}": ${(err as Error).message}`);
    }
    return oneLine('skills', `${STATE.ok}  rejected "${name}" · removed from proposals`);
}

function handleShow(skillsRoot: string, proposedRoot: string, rawName: string): string {
    const name = rawName.trim().toLowerCase();
    if (!SAFE_NAME_RE.test(name)) {
        return oneLine('skills', `${STATE.warn}  invalid skill name "${rawName}"`);
    }
    // Walks both flat and grouped layouts. Proposed dir stays flat (new
    // agent proposals land flat first); active root supports both.
    const found =
        findSkillMd(proposedRoot, name) ?? findSkillMd(skillsRoot, name);
    if (!found) {
        return oneLine('skills', `${STATE.warn}  no skill "${name}" in proposed or active`);
    }
    let body: string;
    try {
        body = readFileSync(found, 'utf-8');
    } catch (err) {
        return oneLine('skills', `${STATE.warn}  could not read "${name}": ${(err as Error).message}`);
    }
    const isProposed = found.includes(`${proposedRoot}`);
    const header = `skills · ${isProposed ? 'proposed' : 'active'} · ${name}`;
    const PREVIEW_CAP = 2000;
    const preview = body.length > PREVIEW_CAP
        ? body.slice(0, PREVIEW_CAP) + `\n\n_(truncated — full file is ${body.length} chars)_`
        : body;
    return `**${header}**\n\n\`\`\`markdown\n${preview}\n\`\`\``;
}

function usage(badSub: string): { text: string } {
    const note = badSub
        ? `unknown subcommand "${badSub}"`
        : 'name required';
    return {
        text: panel(
            [
                {
                    title: 'usage',
                    lines: [
                        row('/skills', 'list active + proposed', 22),
                        row('/skills proposed', 'pending proposals', 22),
                        row('/skills show <name>', 'preview SKILL.md', 22),
                        row('/skills approve <name>', 'promote to active', 22),
                        row('/skills reject <name>', 'discard proposal', 22),
                        row('/skills propose', 'capture skill from current session NOW', 22),
                    ],
                },
            ],
            { header: `skills · ${note}` },
        ),
    };
}

function listSkillRefs(root: string, opts: { skipDir?: string } = {}): SkillRef[] {
    if (!existsSync(root)) return [];
    let entries: string[];
    try {
        entries = readdirSync(root);
    } catch {
        return [];
    }
    const out: SkillRef[] = [];
    const addSkill = (name: string, dir: string): void => {
        const skillFile = join(dir, 'SKILL.md');
        if (!existsSync(skillFile)) return;
        let raw: string;
        try {
            raw = readFileSync(skillFile, 'utf-8');
        } catch {
            return;
        }
        const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
        const fmBody = fmMatch?.[1] ?? '';
        const descMatch = fmBody.match(/^description:\s*(.+)$/m);
        const description = descMatch?.[1]?.trim() ?? '(no description)';
        out.push({ name, description, skillFile });
    };
    for (const entry of entries) {
        if (opts.skipDir && entry === opts.skipDir) continue;
        if (entry.startsWith('.')) continue;
        const dir = join(root, entry);
        try {
            if (!statSync(dir).isDirectory()) continue;
        } catch {
            continue;
        }
        // Flat layout: <root>/<name>/SKILL.md
        if (existsSync(join(dir, 'SKILL.md'))) {
            addSkill(entry, dir);
            continue;
        }
        // Grouped layout: <root>/<group>/<name>/SKILL.md — descend one level.
        // The active root uses grouped layout; without this the list reports
        // zero even when dozens of skills are installed.
        let children: string[];
        try {
            children = readdirSync(dir);
        } catch {
            continue;
        }
        for (const child of children) {
            const childDir = join(dir, child);
            try {
                if (!statSync(childDir).isDirectory()) continue;
            } catch {
                continue;
            }
            addSkill(child, childDir);
        }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + '…';
}

function oneLine(title: string, value: string): string {
    return panel([{ title: '', lines: [row(title.toLowerCase(), value, 8)] }]);
}
