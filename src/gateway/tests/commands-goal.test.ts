import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { goalCommand } from '../src/commands/handlers/goal';
import { setGoalFacade } from '../src/commands/goal-facade';
import { buildLookup, COMMANDS } from '../src/commands/registry';
import type { CommandContext } from '../src/commands/types';
import type { GoalFacade } from '../src/commands/goal-facade';

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
    return {
        args: [],
        rawArgs: '',
        channelName: 'chat',
        peer: { id: 'chat:u1', type: 'user', name: 'u1' },
        threadId: 'chat:u1',
        ...overrides,
    } as CommandContext;
}

function makeFakeFacade(): GoalFacade & { setCalls: unknown[]; pauseCalls: number; clearCalls: number } {
    const setCalls: unknown[] = [];
    let pauseCalls = 0;
    let clearCalls = 0;
    let row: ReturnType<GoalFacade['get']> = null;
    const facade: GoalFacade & { setCalls: unknown[]; pauseCalls: number; clearCalls: number } = {
        setCalls,
        get pauseCalls() { return pauseCalls; },
        get clearCalls() { return clearCalls; },
        get(_threadId) { return row; },
        set(args) {
            setCalls.push(args);
            row = {
                threadId: args.threadId,
                goal: args.goal,
                status: 'active',
                turnsUsed: 0,
                maxTurns: args.maxTurns ?? 20,
                parseFailures: 0,
                createdAt: Date.now(),
                lastTurnAt: Date.now(),
                lastVerdict: null,
                lastReason: null,
                channelName: args.channelName,
                peerId: args.peerId,
            };
            return row!;
        },
        pause(_t) {
            pauseCalls++;
            if (!row) return null;
            row = { ...row, status: 'paused' };
            return row;
        },
        resume(_t) {
            if (!row) return null;
            row = { ...row, status: 'active', turnsUsed: 0 };
            return row;
        },
        clear(_t) {
            clearCalls++;
            const had = row !== null;
            row = null;
            return had;
        },
        async maybeContinue() { return null; },
    };
    return facade;
}

describe('goal command', () => {
    beforeEach(() => setGoalFacade(null));
    afterEach(() => setGoalFacade(null));

    it('is registered with the builtins', () => {
        const lookup = buildLookup(COMMANDS);
        expect(lookup.has('goal')).toBe(true);
    });

    it('warns when no facade is wired', async () => {
        const result = await goalCommand.handler(ctx({ rawArgs: 'do the thing', args: ['do', 'the', 'thing'] }));
        expect(result).not.toBeNull();
        expect(result!.text).toContain('goal loop unavailable');
    });

    it('shows status when no goal exists', async () => {
        setGoalFacade(makeFakeFacade());
        const result = await goalCommand.handler(ctx());
        expect(result!.text).toContain('no goal set');
    });

    it('sets a goal from rawArgs and forwards a kickoff prompt to the agent', async () => {
        const facade = makeFakeFacade();
        setGoalFacade(facade);
        const result = await goalCommand.handler(
            ctx({ rawArgs: 'finish the report', args: ['finish', 'the', 'report'] }),
        );
        expect(result!.text).toContain('GOAL SET');
        expect(result!.forwardToAgent).toContain('finish the report');
        expect(facade.setCalls).toHaveLength(1);
        expect((facade.setCalls[0] as { goal: string }).goal).toBe('finish the report');
    });

    it('pause / resume / clear subcommands hit the facade', async () => {
        const facade = makeFakeFacade();
        setGoalFacade(facade);
        await goalCommand.handler(ctx({ rawArgs: 'do x', args: ['do', 'x'] }));

        const pauseRes = await goalCommand.handler(ctx({ rawArgs: 'pause', args: ['pause'] }));
        expect(pauseRes!.text).toContain('paused');
        expect(facade.pauseCalls).toBe(1);

        const resumeRes = await goalCommand.handler(ctx({ rawArgs: 'resume', args: ['resume'] }));
        expect(resumeRes!.text).toContain('resumed');

        const clearRes = await goalCommand.handler(ctx({ rawArgs: 'clear', args: ['clear'] }));
        expect(clearRes!.text).toContain('cleared');
        expect(facade.clearCalls).toBe(1);
    });

    it('treats /goal status with active row as status, not new goal', async () => {
        const facade = makeFakeFacade();
        setGoalFacade(facade);
        await goalCommand.handler(ctx({ rawArgs: 'ship it', args: ['ship', 'it'] }));
        const statusRes = await goalCommand.handler(ctx({ rawArgs: 'status', args: ['status'] }));
        expect(statusRes!.text).toContain('GOAL STATUS');
        expect(statusRes!.text).toContain('ship it');
        expect(facade.setCalls).toHaveLength(1);
    });

    it('rejects empty `/goal set` with a usage hint', async () => {
        setGoalFacade(makeFakeFacade());
        const result = await goalCommand.handler(ctx({ rawArgs: 'set', args: ['set'] }));
        expect(result!.text).toContain('give a goal');
    });
});
