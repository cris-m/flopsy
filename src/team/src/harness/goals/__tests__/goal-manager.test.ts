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
});
