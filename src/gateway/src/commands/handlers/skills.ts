import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { resolveWorkspacePath, panel, row, STATE } from '@flopsy/shared';
import type { CommandDef, CommandContext } from '../types';

interface SkillRef {
    name: string;
    description: string;
    skillFile: string;
}

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const skillsCommand: CommandDef = {
    name: 'skills',
    description: 'Review skill proposals. `/skills`, `/skills approve <name>`, `/skills reject <name>`.',
    handler: async (ctx: CommandContext) => {
        const sub = (ctx.args[0] ?? '').toLowerCase();
        const target = ctx.args[1] ?? '';

        const skillsRoot = resolveWorkspacePath('skills');
        const proposedRoot = join(skillsRoot, 'proposed');

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

            default:
                return usage(sub);
        }
    },
};

function renderList(skillsRoot: string, proposedRoot: string): string {
    const active = listSkillRefs(skillsRoot, { skipDir: 'proposed' });
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
    const src = join(proposedRoot, name);
    const dest = join(skillsRoot, name);
    if (!existsSync(src) || !existsSync(join(src, 'SKILL.md'))) {
        return oneLine('skills', `${STATE.warn}  no proposed skill "${name}" — try /skills proposed`);
    }
    if (existsSync(dest)) {
        return oneLine('skills', `${STATE.warn}  "${name}" already exists in active skills — reject the proposal or rename it manually`);
    }
    try {
        renameSync(src, dest);
    } catch (err) {
        return oneLine('skills', `${STATE.warn}  could not promote "${name}": ${(err as Error).message}`);
    }
    return panel(
        [
            {
                title: 'approved',
                lines: [
                    row(name, 'moved to active skills', 22),
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
    const target = join(proposedRoot, name);
    if (!existsSync(target)) {
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
    const candidates = [
        join(proposedRoot, name, 'SKILL.md'),
        join(skillsRoot, name, 'SKILL.md'),
    ];
    const found = candidates.find(existsSync);
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
    for (const entry of entries) {
        if (opts.skipDir && entry === opts.skipDir) continue;
        const dir = join(root, entry);
        try {
            if (!statSync(dir).isDirectory()) continue;
        } catch {
            continue;
        }
        const skillFile = join(dir, 'SKILL.md');
        if (!existsSync(skillFile)) continue;
        let raw: string;
        try {
            raw = readFileSync(skillFile, 'utf-8');
        } catch {
            continue;
        }
        const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
        const fmBody = fmMatch?.[1] ?? '';
        const descMatch = fmBody.match(/^description:\s*(.+)$/m);
        const description = descMatch?.[1]?.trim() ?? '(no description)';
        out.push({ name: entry, description, skillFile });
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
