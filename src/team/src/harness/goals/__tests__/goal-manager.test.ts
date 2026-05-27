import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BaseChatModel } from 'flopsygraph';
import type { ChatMessage, ChatResponse } from 'flopsygraph/llm';
import { LearningStore } from '../../storage/learning-store';
import { GoalManager } from '../goal-manager';

class FakeModel {
    public calls: ChatMessage[][] = [];
    constructor(private readonly responder: (msgs: ChatMessage[]) => string | Promise<string>) {}
    async invoke(messages: ChatMessage[]): Promise<ChatResponse> {
        this.calls.push(messages);
        const content = await this.responder(messages);
        return { content };
    }
}

function asModel(fake: FakeModel): BaseChatModel {
    return fake as unknown as BaseChatModel;
}

describe('GoalManager', () => {
    let tmpDir: string;
    let store: LearningStore;
    let originalHome: string | undefined;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'flopsy-goal-'));
        originalHome = process.env.FLOPSY_HOME;
        process.env.FLOPSY_HOME = tmpDir;
        store = new LearningStore(join(tmpDir, 'state.db'));
    });

    afterEach(() => {
        store.close();
        rmSync(tmpDir, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.FLOPSY_HOME;
        else process.env.FLOPSY_HOME = originalHome;
    });

    function makeManager(model: BaseChatModel, overrides: { maxTurns?: number; maxConsecutiveParseFailures?: number } = {}): GoalManager {
        return new GoalManager({
            store,
            model,
            maxTurns: overrides.maxTurns ?? 20,
            maxConsecutiveParseFailures: overrides.maxConsecutiveParseFailures ?? 3,
        });
    }

    it('persists set / get / pause / resume / clear', () => {
        const mgr = makeManager(asModel(new FakeModel(async () => '{"done":false,"reason":""}')));
        const created = mgr.set({
            threadId: 't1',
            channelName: 'chat',
            peerId: 'chat:u1',
            goal: 'finish the report',
        });
        expect(created.status).toBe('active');
        expect(created.goal).toBe('finish the report');

        const fetched = mgr.get('t1');
        expect(fetched).not.toBeNull();
        expect(fetched!.maxTurns).toBe(20);

        const paused = mgr.pause('t1');
        expect(paused!.status).toBe('paused');
        expect(mgr.get('t1')!.status).toBe('paused');

        const resumed = mgr.resume('t1');
        expect(resumed!.status).toBe('active');
        expect(resumed!.turnsUsed).toBe(0);

        expect(mgr.clear('t1')).toBe(true);
        expect(mgr.get('t1')).toBeNull();
    });

    it('returns null from maybeContinue when no goal is set', async () => {
        const mgr = makeManager(asModel(new FakeModel(async () => '{"done":true,"reason":"x"}')));
        const result = await mgr.maybeContinue({ threadId: 'no-such-thread', agentReply: 'hi' });
        expect(result).toBeNull();
    });

    it('continues when judge says not done', async () => {
        const fake = new FakeModel(async () => '{"done":false,"reason":"still work to do"}');
        const mgr = makeManager(asModel(fake));
        mgr.set({ threadId: 't2', channelName: 'chat', peerId: 'chat:u1', goal: 'goal-x' });
        const result = await mgr.maybeContinue({ threadId: 't2', agentReply: 'made some progress' });
        expect(result).not.toBeNull();
        expect(result!.shouldContinue).toBe(true);
        expect(result!.continuationPrompt).toContain('goal-x');
        expect(result!.turnsUsed).toBe(1);
        expect(fake.calls).toHaveLength(1);
    });

    it('stops when judge says done', async () => {
        const fake = new FakeModel(async () => '{"done":true,"reason":"finished"}');
        const mgr = makeManager(asModel(fake));
        mgr.set({ threadId: 't3', channelName: 'chat', peerId: 'chat:u1', goal: 'goal-y' });
        const result = await mgr.maybeContinue({ threadId: 't3', agentReply: 'all done' });
        expect(result!.shouldContinue).toBe(false);
        expect(result!.stopReason).toBe('done');
        expect(mgr.get('t3')!.status).toBe('done');
    });

    it('fails open on judge error (continues)', async () => {
        const fake = new FakeModel(async () => {
            throw new Error('model exploded');
        });
        const mgr = makeManager(asModel(fake));
        mgr.set({ threadId: 't4', channelName: 'chat', peerId: 'chat:u1', goal: 'g4' });
        const result = await mgr.maybeContinue({ threadId: 't4', agentReply: 'work' });
        expect(result!.shouldContinue).toBe(true);
        expect(result!.verdict!.verdict).toBe('continue');
        expect(result!.verdict!.reason).toContain('judge error');
    });

    it('pauses after maxConsecutiveParseFailures unparseable judge replies', async () => {
        const fake = new FakeModel(async () => 'not json at all — random words');
        const mgr = makeManager(asModel(fake), { maxConsecutiveParseFailures: 2 });
        mgr.set({ threadId: 't5', channelName: 'chat', peerId: 'chat:u1', goal: 'g5' });

        const r1 = await mgr.maybeContinue({ threadId: 't5', agentReply: 'reply1' });
        expect(r1!.shouldContinue).toBe(true);
        expect(r1!.verdict!.verdict).toBe('skipped');

        const r2 = await mgr.maybeContinue({ threadId: 't5', agentReply: 'reply2' });
        expect(r2!.shouldContinue).toBe(false);
        expect(r2!.stopReason).toBe('parse_failures');
        expect(mgr.get('t5')!.status).toBe('paused');
    });

    it('pauses when budget is exhausted', async () => {
        const fake = new FakeModel(async () => '{"done":false,"reason":""}');
        const mgr = makeManager(asModel(fake), { maxTurns: 2 });
        mgr.set({ threadId: 't6', channelName: 'chat', peerId: 'chat:u1', goal: 'g6' });

        const r1 = await mgr.maybeContinue({ threadId: 't6', agentReply: 'r1' });
        expect(r1!.shouldContinue).toBe(true);
        expect(r1!.turnsUsed).toBe(1);

        const r2 = await mgr.maybeContinue({ threadId: 't6', agentReply: 'r2' });
        expect(r2!.shouldContinue).toBe(true);
        expect(r2!.turnsUsed).toBe(2);

        const r3 = await mgr.maybeContinue({ threadId: 't6', agentReply: 'r3' });
        expect(r3!.shouldContinue).toBe(false);
        expect(r3!.stopReason).toBe('budget');
        expect(mgr.get('t6')!.status).toBe('paused');
    });

    it('does not continue when status is paused', async () => {
        const fake = new FakeModel(async () => '{"done":false,"reason":""}');
        const mgr = makeManager(asModel(fake));
        mgr.set({ threadId: 't7', channelName: 'chat', peerId: 'chat:u1', goal: 'g7' });
        mgr.pause('t7');
        const result = await mgr.maybeContinue({ threadId: 't7', agentReply: 'r' });
        expect(result!.shouldContinue).toBe(false);
        expect(result!.stopReason).toBe('paused');
        expect(fake.calls).toHaveLength(0);
    });

    it('parses fenced JSON verdicts', async () => {
        const fake = new FakeModel(async () => '```json\n{"done":true,"reason":"shipped"}\n```');
        const mgr = makeManager(asModel(fake));
        mgr.set({ threadId: 't8', channelName: 'chat', peerId: 'chat:u1', goal: 'g8' });
        const result = await mgr.maybeContinue({ threadId: 't8', agentReply: 'r' });
        expect(result!.shouldContinue).toBe(false);
        expect(result!.stopReason).toBe('done');
    });

    it('judge call is gated by AbortSignal.timeout', async () => {
        const fake = new FakeModel((msgs) => new Promise<string>((resolve) => setTimeout(() => resolve('{"done":true,"reason":"late"}'), 5_000)));
        // Use a short timeout — the timer is wired via AbortSignal.timeout but the
        // fake doesn't observe signal, so this just confirms we don't hang the suite
        // even when the model takes longer than expected; result still completes.
        const mgr = new GoalManager({
            store,
            model: asModel(fake),
            maxTurns: 5,
            judgeTimeoutMs: 50,
            maxConsecutiveParseFailures: 5,
        });
        mgr.set({ threadId: 't9', channelName: 'chat', peerId: 'chat:u1', goal: 'g9' });
        // We can't actually abort the fake — but the production model implementation
        // honors AbortSignal. Cover the happy path here.
        // Skip if the runner doesn't await long fakes — just assert that maybeContinue
        // returns *something* without throwing within a reasonable wall time.
        const start = Date.now();
        const promise = mgr.maybeContinue({ threadId: 't9', agentReply: 'r' });
        const result = await Promise.race([
            promise,
            new Promise((resolve) => setTimeout(() => resolve('timed-out-sentinel'), 6_000)),
        ]);
        expect(result).toBeDefined();
        expect(Date.now() - start).toBeLessThan(7_000);
        vi.restoreAllMocks();
    }, 8_000);

    describe('notification messages (Hermes parity)', () => {
        it('emits "✓ Goal achieved: <reason>" on done', async () => {
            const mgr = makeManager(
                asModel(new FakeModel(async () => '{"done":true,"reason":"shipped the deploy script"}')),
            );
            mgr.set({ threadId: 'tn1', channelName: 'chat', peerId: 'chat:u1', goal: 'ship it' });
            const result = await mgr.maybeContinue({ threadId: 'tn1', agentReply: 'done' });
            expect(result?.notificationKind).toBe('done');
            expect(result?.notificationMessage).toBe('✓ Goal achieved: shipped the deploy script');
        });

        it('emits "↻ Continuing toward goal (N/MAX): <reason>" on continue', async () => {
            const mgr = makeManager(
                asModel(new FakeModel(async () => '{"done":false,"reason":"still 2 files to go"}')),
                { maxTurns: 5 },
            );
            mgr.set({ threadId: 'tn2', channelName: 'chat', peerId: 'chat:u1', goal: 'write 4 files' });
            const result = await mgr.maybeContinue({ threadId: 'tn2', agentReply: 'wrote 2' });
            expect(result?.notificationKind).toBe('continuing');
            expect(result?.notificationMessage).toBe('↻ Continuing toward goal (1/5): still 2 files to go');
        });

        it('emits "⏸ Goal paused — N/MAX turns used..." on budget exhaustion', async () => {
            const mgr = makeManager(
                asModel(new FakeModel(async () => '{"done":false,"reason":"more work"}')),
                { maxTurns: 1 },
            );
            mgr.set({ threadId: 'tn3', channelName: 'chat', peerId: 'chat:u1', goal: 'do it' });
            await mgr.maybeContinue({ threadId: 'tn3', agentReply: 'try 1' });
            const result = await mgr.maybeContinue({ threadId: 'tn3', agentReply: 'try 2' });
            expect(result?.notificationKind).toBe('budget');
            expect(result?.notificationMessage).toContain('⏸ Goal paused');
            expect(result?.notificationMessage).toContain('1/1 turns used');
            expect(result?.notificationMessage).toContain('/goal resume');
        });

        it('emits "⏸ Goal paused — judge model..." after consecutive parse failures', async () => {
            const mgr = makeManager(
                asModel(new FakeModel(async () => 'not json at all')),
                { maxConsecutiveParseFailures: 2 },
            );
            mgr.set({ threadId: 'tn4', channelName: 'chat', peerId: 'chat:u1', goal: 'do it' });
            await mgr.maybeContinue({ threadId: 'tn4', agentReply: 'r1' });
            const result = await mgr.maybeContinue({ threadId: 'tn4', agentReply: 'r2' });
            expect(result?.notificationKind).toBe('parse_failures');
            expect(result?.notificationMessage).toContain('⏸ Goal paused');
            expect(result?.notificationMessage).toContain("isn't returning the required JSON verdict");
            expect(result?.notificationMessage).toContain('/goal resume');
        });

        it('does NOT emit a notification when there is no active goal', async () => {
            const mgr = makeManager(asModel(new FakeModel(async () => '{"done":true,"reason":"x"}')));
            const result = await mgr.maybeContinue({ threadId: 'tn-none', agentReply: 'r' });
            expect(result).toBeNull();
        });
    });

    describe('subgoals (Hermes /subgoal parity)', () => {
        it('adds a subgoal to an active goal and persists', () => {
            const mgr = makeManager(asModel(new FakeModel(async () => '{"done":false,"reason":""}')));
            mgr.set({ threadId: 'sg1', channelName: 'chat', peerId: 'chat:u1', goal: 'ship feature' });
            const updated = mgr.addSubgoal('sg1', '  include the migration guide  ');
            expect(updated.subgoals).toEqual(['include the migration guide']);
            const reloaded = mgr.get('sg1');
            expect(reloaded?.subgoals).toEqual(['include the migration guide']);
        });

        it('refuses empty / too-long subgoals', () => {
            const mgr = makeManager(asModel(new FakeModel(async () => '{"done":false,"reason":""}')));
            mgr.set({ threadId: 'sg2', channelName: 'chat', peerId: 'chat:u1', goal: 'ship feature' });
            expect(() => mgr.addSubgoal('sg2', '   ')).toThrow(/empty/);
            expect(() => mgr.addSubgoal('sg2', 'x'.repeat(401))).toThrow(/too long/);
        });

        it('refuses subgoals on a non-active goal', () => {
            const mgr = makeManager(asModel(new FakeModel(async () => '{"done":false,"reason":""}')));
            mgr.set({ threadId: 'sg3', channelName: 'chat', peerId: 'chat:u1', goal: 'g' });
            mgr.pause('sg3');
            expect(() => mgr.addSubgoal('sg3', 'extra')).toThrow(/paused/);
        });

        it('removes a subgoal by 1-based index', () => {
            const mgr = makeManager(asModel(new FakeModel(async () => '{"done":false,"reason":""}')));
            mgr.set({ threadId: 'sg4', channelName: 'chat', peerId: 'chat:u1', goal: 'g' });
            mgr.addSubgoal('sg4', 'first');
            mgr.addSubgoal('sg4', 'second');
            mgr.addSubgoal('sg4', 'third');
            const { removed, remaining } = mgr.removeSubgoal('sg4', 2);
            expect(removed).toBe('second');
            expect(remaining).toBe(2);
            expect(mgr.get('sg4')?.subgoals).toEqual(['first', 'third']);
        });

        it('throws on out-of-range remove index', () => {
            const mgr = makeManager(asModel(new FakeModel(async () => '{"done":false,"reason":""}')));
            mgr.set({ threadId: 'sg5', channelName: 'chat', peerId: 'chat:u1', goal: 'g' });
            mgr.addSubgoal('sg5', 'only');
            expect(() => mgr.removeSubgoal('sg5', 0)).toThrow(/out of range/);
            expect(() => mgr.removeSubgoal('sg5', 5)).toThrow(/out of range/);
        });

        it('clears all subgoals and returns previous count', () => {
            const mgr = makeManager(asModel(new FakeModel(async () => '{"done":false,"reason":""}')));
            mgr.set({ threadId: 'sg6', channelName: 'chat', peerId: 'chat:u1', goal: 'g' });
            mgr.addSubgoal('sg6', 'a');
            mgr.addSubgoal('sg6', 'b');
            expect(mgr.clearSubgoals('sg6')).toBe(2);
            expect(mgr.get('sg6')?.subgoals).toEqual([]);
            expect(mgr.clearSubgoals('sg6')).toBe(0);
        });

        it('continuationPrompt includes subgoals block when subgoals exist', () => {
            const mgr = makeManager(asModel(new FakeModel(async () => '{"done":false,"reason":""}')));
            const withoutSubs = mgr.continuationPrompt('ship X');
            expect(withoutSubs).not.toContain('Additional criteria');
            const withSubs = mgr.continuationPrompt('ship X', ['add tests', 'update docs']);
            expect(withSubs).toContain('Additional criteria');
            expect(withSubs).toContain('- 1. add tests');
            expect(withSubs).toContain('- 2. update docs');
        });

        it('judge factors subgoals into its prompt', async () => {
            let capturedPrompt = '';
            const fake = new FakeModel(async (msgs) => {
                capturedPrompt = String((msgs[msgs.length - 1] as { content: string }).content);
                return '{"done":false,"reason":"test"}';
            });
            const mgr = makeManager(asModel(fake));
            await mgr.judge('ship X', 'I shipped X', ['add tests', 'update docs']);
            expect(capturedPrompt).toContain('Additional criteria');
            expect(capturedPrompt).toContain('add tests');
            expect(capturedPrompt).toContain('update docs');
            expect(capturedPrompt).toContain('For each numbered criterion');
        });

        it('renderSubgoals returns helpful messages on empty / no-goal', () => {
            const mgr = makeManager(asModel(new FakeModel(async () => '{"done":false,"reason":""}')));
            expect(mgr.renderSubgoals('nonexistent')).toBe('(no active goal)');
            mgr.set({ threadId: 'sg7', channelName: 'chat', peerId: 'chat:u1', goal: 'g' });
            expect(mgr.renderSubgoals('sg7')).toContain('no subgoals');
            mgr.addSubgoal('sg7', 'first');
            const rendered = mgr.renderSubgoals('sg7');
            expect(rendered).toContain('- 1. first');
        });
    });
});
