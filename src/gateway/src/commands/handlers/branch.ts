import type { CommandDef, CommandContext } from '../types';
import { getBranchFacade, type BranchSummary } from '../branch-facade';
import { panel, row, STATE } from '@flopsy/shared';

const RESERVED = new Set(['list', 'switch', 'help', '?']);
const MAX_LABEL_LEN = 40;

export const branchCommand: CommandDef = {
    name: 'branch',
    aliases: ['fork'],
    description:
        'Fork or switch named conversation branches. `/branch <name>`, `/branch list`, `/branch switch <name>`.',
    handler: async (ctx: CommandContext): Promise<{ text: string } | null> => {
        const facade = getBranchFacade();
        if (!facade) {
            return {
                text: panel([
                    {
                        title: '',
                        lines: [row('branch', `${STATE.warn}  not wired (engine not started)`, 12)],
                    },
                ]),
            };
        }

        const args = ctx.rawArgs.trim().split(/\s+/).filter((s) => s.length > 0);
        const sub = args[0]?.toLowerCase() ?? '';

        if (sub === '' || sub === 'help' || sub === '?') {
            return { text: renderUsage() };
        }

        if (sub === 'list') {
            const branches = facade.list(ctx.threadId);
            return { text: renderList(branches) };
        }

        if (sub === 'switch') {
            const target = args.slice(1).join(' ');
            if (!target) {
                return { text: renderError('switch requires a branch name. `/branch list` to see options.') };
            }
            const result = await facade.switch(ctx.threadId, target);
            return { text: renderSwitchResult(result, target) };
        }

        // Bare name → fork. Re-join in case the label has spaces.
        const label = args.join(' ');
        const validation = validateLabel(label);
        if (validation) return { text: renderError(validation) };

        const result = await facade.fork(ctx.threadId, label);
        return { text: renderForkResult(result, label) };
    },
};

function validateLabel(label: string): string | null {
    const trimmed = label.trim();
    if (trimmed.length === 0) return 'branch name cannot be empty';
    if (trimmed.length > MAX_LABEL_LEN) return `branch name too long (max ${MAX_LABEL_LEN} chars)`;
    if (RESERVED.has(trimmed.toLowerCase())) {
        return `"${trimmed}" is a reserved keyword — pick a different label`;
    }
    return null;
}

function renderUsage(): string {
    return panel(
        [
            {
                title: 'usage',
                lines: [
                    row('fork', '/branch <name>', 12),
                    row('list', '/branch list', 12),
                    row('switch', '/branch switch <name>', 12),
                ],
            },
        ],
        { header: 'BRANCH' },
    );
}

function renderError(msg: string): string {
    return panel(
        [{ title: '', lines: [row('branch', `${STATE.warn}  ${msg}`, 12)] }],
        { header: 'BRANCH' },
    );
}

function renderForkResult(
    result: Awaited<ReturnType<NonNullable<ReturnType<typeof getBranchFacade>>['fork']>>,
    label: string,
): string {
    if (result.ok) {
        return panel(
            [
                {
                    title: 'forked',
                    lines: [
                        row('branch', `${STATE.ok}  "${result.label}" — now active`, 12),
                        row('hint', 'next message lands here · `/branch list` to see all', 12),
                    ],
                },
            ],
            { header: 'BRANCH' },
        );
    }
    const detail = forkErrorDetail(result.reason, label);
    return renderError(detail);
}

function forkErrorDetail(reason: string, label: string): string {
    switch (reason) {
        case 'no-active-session':
            return 'no active session yet — send a message first, then branch';
        case 'duplicate':
            return `branch "${label}" already exists — pick a different name or \`/branch switch ${label}\``;
        case 'invalid-label':
            return 'branch name cannot be empty';
        default:
            return 'failed to fork — see logs for details';
    }
}

function renderSwitchResult(
    result: Awaited<ReturnType<NonNullable<ReturnType<typeof getBranchFacade>>['switch']>>,
    label: string,
): string {
    if (result.ok) {
        return panel(
            [
                {
                    title: 'switched',
                    lines: [
                        row('branch', `${STATE.ok}  "${result.label}" — now active`, 12),
                        row('hint', 'next message lands here', 12),
                    ],
                },
            ],
            { header: 'BRANCH' },
        );
    }
    if (result.reason === 'unknown-label') {
        return renderError(`no branch named "${label}" — \`/branch list\` to see options`);
    }
    return renderError('branch name cannot be empty');
}

function renderList(branches: ReadonlyArray<BranchSummary>): string {
    if (branches.length === 0) {
        return panel(
            [
                {
                    title: 'branches',
                    lines: [row('status', 'no branches yet — `/branch <name>` to fork here', 12)],
                },
            ],
            { header: 'BRANCH' },
        );
    }

    const lines = branches.map((b) => {
        const labelText = b.label ?? '(unlabeled)';
        const tag = b.active ? `${STATE.ok} ${labelText}` : labelText;
        const turns = `${b.turnCount} turn${b.turnCount === 1 ? '' : 's'}`;
        const when = fmtRel(b.lastUserMessageAt);
        const summary = b.summary ? ` · ${truncate(b.summary, 60)}` : '';
        return row(tag, `${turns} · ${when}${summary}`, 22);
    });

    return panel([{ title: 'branches', lines }], { header: 'BRANCH' });
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

function fmtRel(ts: number): string {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60_000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}
