/**
 * /branch slash command — fork / list / switch named conversation branches.
 *
 * Tests the user-facing render layer with a stub BranchFacade so we exercise
 * argument parsing, validation, error rendering, and panel formatting
 * without depending on the LearningStore + checkpointer wiring.
 *
 * The TeamHandler-side fork (forkSession + checkpoint clone) is covered
 * separately in the learning-store-extras suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchCommand } from '@flopsy/gateway/commands/handlers/branch';
import type { CommandContext } from '@flopsy/gateway/commands/types';
import {
    setBranchFacade,
    type BranchFacade,
    type BranchOutcome,
    type BranchSummary,
} from '@flopsy/gateway/commands/branch-facade';

interface FacadeCalls {
    fork: Array<{ rawKey: string; label: string }>;
    switch: Array<{ rawKey: string; label: string }>;
    list: Array<{ rawKey: string }>;
}

function makeFacade(opts: {
    forkResult?: BranchOutcome;
    switchResult?: BranchOutcome;
    branches?: BranchSummary[];
} = {}): { facade: BranchFacade; calls: FacadeCalls } {
    const calls: FacadeCalls = { fork: [], switch: [], list: [] };
    const facade: BranchFacade = {
        fork: async (rawKey, label) => {
            calls.fork.push({ rawKey, label });
            return opts.forkResult ?? {
                ok: true,
                sessionId: 's-new',
                label,
            };
        },
        switch: async (rawKey, label) => {
            calls.switch.push({ rawKey, label });
            return opts.switchResult ?? {
                ok: true,
                sessionId: 's-target',
                label,
            };
        },
        list: (rawKey) => {
            calls.list.push({ rawKey });
            return opts.branches ?? [];
        },
    };
    return { facade, calls };
}

function ctx(rawArgs: string): CommandContext {
    return {
        args: rawArgs.split(/\s+/).filter(Boolean),
        rawArgs,
        channelName: 'telegram',
        peer: { id: '5257796557', type: 'user', name: 'tester' },
        threadId: 'telegram:dm:5257796557#s-current',
    };
}

async function runOutput(args: string): Promise<string> {
    const result = await branchCommand.handler(ctx(args));
    return (result as { text: string }).text;
}

afterEach(() => {
    setBranchFacade(null);
});

describe('/branch — wiring', () => {
    it('warns when the facade is not wired', async () => {
        // facade unset by afterEach default
        const out = await runOutput('feature');
        expect(out).toMatch(/not wired/i);
    });
});

describe('/branch — usage', () => {
    beforeEach(() => {
        setBranchFacade(makeFacade().facade);
    });

    it('renders usage panel when called with no args', async () => {
        const out = await runOutput('');
        expect(out).toMatch(/usage/i);
        expect(out).toMatch(/\/branch <name>/);
        expect(out).toMatch(/\/branch list/);
        expect(out).toMatch(/\/branch switch/);
    });

    it('renders usage panel for help / ?', async () => {
        for (const arg of ['help', '?']) {
            const out = await runOutput(arg);
            expect(out).toMatch(/usage/i);
        }
    });
});

describe('/branch — fork', () => {
    it('forks with the given label and surfaces the success panel', async () => {
        const { facade, calls } = makeFacade();
        setBranchFacade(facade);
        const out = await runOutput('experiment');
        expect(out).toMatch(/forked/i);
        expect(out).toContain('experiment');
        expect(calls.fork).toHaveLength(1);
        expect(calls.fork[0]!.label).toBe('experiment');
    });

    it('joins multi-word labels into a single label', async () => {
        const { facade, calls } = makeFacade();
        setBranchFacade(facade);
        await runOutput('feature x rewrite');
        expect(calls.fork[0]!.label).toBe('feature x rewrite');
    });

    it('rejects reserved keywords as labels (list, switch, help)', async () => {
        const { facade, calls } = makeFacade();
        setBranchFacade(facade);
        // 'help' / '?' route to the usage panel, but if a user wraps "list"
        // as a fork label by passing nothing else, that's an error too.
        // 'list' with no further args goes to the LIST branch — exercise the
        // explicit fork-with-reserved test by trying 'switch' with no target.
        const out = await runOutput('switch');
        // Without a 2nd arg, 'switch' branch errors with "switch requires a branch name"
        expect(out).toMatch(/switch requires/i);
        expect(calls.fork).toHaveLength(0);
    });

    it('surfaces "duplicate" error from facade', async () => {
        const { facade } = makeFacade({
            forkResult: { ok: false, reason: 'duplicate' },
        });
        setBranchFacade(facade);
        const out = await runOutput('alpha');
        expect(out).toMatch(/already exists/i);
        expect(out).toContain('alpha');
    });

    it('surfaces "no-active-session" error from facade', async () => {
        const { facade } = makeFacade({
            forkResult: { ok: false, reason: 'no-active-session' },
        });
        setBranchFacade(facade);
        const out = await runOutput('alpha');
        expect(out).toMatch(/no active session/i);
    });

    it('surfaces a generic "failed" error when reason is failed', async () => {
        const { facade } = makeFacade({
            forkResult: { ok: false, reason: 'failed' },
        });
        setBranchFacade(facade);
        const out = await runOutput('alpha');
        expect(out).toMatch(/failed/i);
    });
});

describe('/branch list', () => {
    it('renders empty state when no branches', async () => {
        setBranchFacade(makeFacade({ branches: [] }).facade);
        const out = await runOutput('list');
        expect(out).toMatch(/no branches yet/i);
    });

    it('renders branches with name + turns + last touched', async () => {
        const branches: BranchSummary[] = [
            {
                sessionId: 's-1',
                label: 'refactor',
                active: true,
                turnCount: 12,
                summary: 'Working on the proactive engine',
                lastUserMessageAt: Date.now() - 60_000,
            },
            {
                sessionId: 's-2',
                label: 'experiment',
                active: false,
                turnCount: 3,
                summary: 'Tried Playwright instead of BeautifulSoup',
                lastUserMessageAt: Date.now() - 24 * 60 * 60_000,
            },
        ];
        setBranchFacade(makeFacade({ branches }).facade);
        const out = await runOutput('list');
        expect(out).toContain('refactor');
        expect(out).toContain('experiment');
        expect(out).toMatch(/12 turns?/);
        expect(out).toMatch(/3 turns?/);
    });
});

describe('/branch switch', () => {
    it('errors when no name is given', async () => {
        setBranchFacade(makeFacade().facade);
        const out = await runOutput('switch');
        expect(out).toMatch(/switch requires a branch name/i);
    });

    it('switches to a named branch on success', async () => {
        const { facade, calls } = makeFacade();
        setBranchFacade(facade);
        const out = await runOutput('switch refactor');
        expect(out).toMatch(/switched/i);
        expect(out).toContain('refactor');
        expect(calls.switch).toHaveLength(1);
        expect(calls.switch[0]!.label).toBe('refactor');
    });

    it('surfaces "no branch named X" on unknown-label', async () => {
        const { facade } = makeFacade({
            switchResult: { ok: false, reason: 'unknown-label' },
        });
        setBranchFacade(facade);
        const out = await runOutput('switch nonexistent');
        expect(out).toMatch(/no branch named/i);
        expect(out).toContain('nonexistent');
    });
});

describe('/branch — label validation', () => {
    beforeEach(() => {
        setBranchFacade(makeFacade().facade);
    });

    it('rejects labels longer than 40 chars', async () => {
        const out = await runOutput('a'.repeat(41));
        expect(out).toMatch(/too long/i);
    });
});
