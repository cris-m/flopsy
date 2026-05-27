import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { subgoalCommand } from '../src/commands/handlers/subgoal';
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

function makeFacade(initialSubgoals: string[] = [], activeGoal = 'ship the feature'): GoalFacade & {
    addCalls: string[];
    removeCalls: number[];
    clearCalls: number;
} {
    const addCalls: string[] = [];
    const removeCalls: number[] = [];
    let clearCalls = 0;
    let subgoals = [...initialSubgoals];
    const baseRow = activeGoal
        ? {
              threadId: 'chat:u1',
              goal: activeGoal,
              status: 'active' as const,
              turnsUsed: 0,
              maxTurns: 20,
              parseFailures: 0,
              createdAt: Date.now(),
              lastTurnAt: Date.now(),
              lastVerdict: null,
              lastReason: null,
              channelName: 'chat',
              peerId: 'chat:u1',
              subgoals,
          }
        : null;
    const facade: GoalFacade & { addCalls: string[]; removeCalls: number[]; clearCalls: number } = {
        addCalls,
        removeCalls,
        get clearCalls() { return clearCalls; },
        get() { return baseRow ? { ...baseRow, subgoals: [...subgoals] } : null; },
        set() { throw new Error('not used in these tests'); },
        pause() { return baseRow; },
        resume() { return baseRow; },
        clear() { return true; },
        async maybeContinue() { return null; },
        addSubgoal(_t, text) {
            const trimmed = text.trim();
            if (!trimmed) throw new Error('subgoal text cannot be empty');
            subgoals = [...subgoals, trimmed];
            addCalls.push(trimmed);
            return { ...baseRow!, subgoals };
        },
        removeSubgoal(_t, idx) {
            removeCalls.push(idx);
            const i = idx - 1;
            if (i < 0 || i >= subgoals.length) throw new Error(`index out of range (1..${subgoals.length})`);
            const removed = subgoals[i]!;
            subgoals = [...subgoals.slice(0, i), ...subgoals.slice(i + 1)];
            return { removed, remaining: subgoals.length };
        },
        clearSubgoals() {
            clearCalls++;
            const n = subgoals.length;
            subgoals = [];
            return n;
        },
        renderSubgoals() {
            if (subgoals.length === 0) return '(no subgoals — use /subgoal <text> to add criteria)';
            return subgoals.map((s, i) => `- ${i + 1}. ${s}`).join('\n');
        },
    };
    return facade;
}

describe('subgoal command', () => {
    beforeEach(() => setGoalFacade(null));
    afterEach(() => setGoalFacade(null));

    it('is registered with the builtins', () => {
        const lookup = buildLookup(COMMANDS);
        expect(lookup.has('subgoal')).toBe(true);
    });

    it('warns when no facade is wired', async () => {
        const result = await subgoalCommand.handler(ctx({ rawArgs: 'extra criterion', args: ['extra', 'criterion'] }));
        expect(result?.text).toContain('goal loop unavailable');
    });

    it('warns when no active goal exists', async () => {
        const facade = makeFacade([], '');
        setGoalFacade(facade);
        const result = await subgoalCommand.handler(ctx({ rawArgs: 'do X', args: ['do', 'X'] }));
        expect(result?.text).toContain('no active goal');
    });

    it('adds a subgoal with raw text', async () => {
        const facade = makeFacade();
        setGoalFacade(facade);
        const result = await subgoalCommand.handler(ctx({ rawArgs: 'include tests', args: ['include', 'tests'] }));
        expect(facade.addCalls).toEqual(['include tests']);
        expect(result?.text).toContain('SUBGOAL ADDED');
    });

    it('lists existing subgoals when called with no args', async () => {
        const facade = makeFacade(['add tests', 'update docs']);
        setGoalFacade(facade);
        const result = await subgoalCommand.handler(ctx());
        expect(result?.text).toContain('SUBGOAL LIST');
        expect(result?.text).toContain('1. add tests');
        expect(result?.text).toContain('2. update docs');
    });

    it('removes a subgoal by index', async () => {
        const facade = makeFacade(['first', 'second', 'third']);
        setGoalFacade(facade);
        const result = await subgoalCommand.handler(ctx({ rawArgs: 'remove 2', args: ['remove', '2'] }));
        expect(facade.removeCalls).toEqual([2]);
        expect(result?.text).toContain('removed');
        expect(result?.text).toContain('second');
    });

    it('reports usage error when remove index is not a number', async () => {
        const facade = makeFacade(['first']);
        setGoalFacade(facade);
        const result = await subgoalCommand.handler(ctx({ rawArgs: 'remove abc', args: ['remove', 'abc'] }));
        expect(result?.text).toContain('usage: /subgoal remove <N>');
    });

    it('clears all subgoals', async () => {
        const facade = makeFacade(['a', 'b']);
        setGoalFacade(facade);
        const result = await subgoalCommand.handler(ctx({ rawArgs: 'clear', args: ['clear'] }));
        expect(facade.clearCalls).toBe(1);
        expect(result?.text).toContain('cleared');
    });

    it('returns the warn message when clearing with nothing', async () => {
        const facade = makeFacade([]);
        setGoalFacade(facade);
        const result = await subgoalCommand.handler(ctx({ rawArgs: 'clear', args: ['clear'] }));
        expect(result?.text).toContain('nothing to clear');
    });

    it('surfaces errors thrown by the facade', async () => {
        const facade = makeFacade(['one']);
        setGoalFacade(facade);
        const result = await subgoalCommand.handler(ctx({ rawArgs: 'remove 5', args: ['remove', '5'] }));
        expect(result?.text).toContain('out of range');
    });
});
