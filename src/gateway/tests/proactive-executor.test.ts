/**
 * JobExecutor — pipeline branches that decide whether a fire delivers, suppresses,
 * queues, or errors. The historical bugs that produced garbage Telegram messages
 * lived here:
 *   - silent ENOENT fallback let an empty prompt run the agent → improvised content
 *   - heartbeat fires reused the user's session thread (job.threadId set) → no
 *     ephemeral cleanup → 132K-token context overflow after ~20 fires
 *
 * These tests exercise the executor directly with stubs for every collaborator,
 * so the contract under test is just: prompt + jobState + presence + agent reply
 * → action.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobExecutor, parseConditionalResponse } from '../src/proactive/pipeline/executor';
import { StateStore } from '../src/proactive/state/store';
import { ProactiveDedupStore } from '../src/proactive/state/dedup-store';
import { PresenceManager } from '../src/proactive/state/presence';
import { RetryQueue } from '../src/proactive/state/retry-queue';
import { ChannelRouter } from '../src/proactive/delivery/router';
import type { ExecutionJob, AgentCaller, ThreadCleaner } from '../src/proactive/types';

interface Harness {
    workDir: string;
    store: StateStore;
    dedup: ProactiveDedupStore;
    presence: PresenceManager;
    retry: RetryQueue;
    cleanups: string[];
    sentMessages: Array<{ channel: string; peerId: string; text: string }>;
    agentCalls: Array<{ message: string; threadId: string | undefined }>;
    setAgent: (fn: AgentCaller) => void;
    setRouter: (router: ChannelRouter) => void;
    cleanup: () => void;
}

function makeHarness(): Harness & { build: () => JobExecutor } {
    const workDir = mkdtempSync(join(tmpdir(), 'flopsy-executor-'));
    const statePath = join(workDir, 'proactive.json');
    const dedupPath = join(workDir, 'proactive.db');
    const retryPath = join(workDir, 'retry-queue.json');

    const store = new StateStore(statePath);
    const dedup = new ProactiveDedupStore(dedupPath);
    const presence = new PresenceManager(store);
    const retry = new RetryQueue(retryPath);

    const cleanups: string[] = [];
    const sentMessages: Harness['sentMessages'] = [];
    const agentCalls: Harness['agentCalls'] = [];

    let agentImpl: AgentCaller = async () => ({ response: 'default reply' });
    const threadCleaner: ThreadCleaner = async (id) => {
        cleanups.push(id);
    };
    let router = new ChannelRouter(
        () => true,
        async (channel, peer, text) => {
            sentMessages.push({ channel, peerId: peer.id, text });
            return 'msg-id';
        },
    );

    const harness: Harness & { build: () => JobExecutor } = {
        workDir,
        store,
        dedup,
        presence,
        retry,
        cleanups,
        sentMessages,
        agentCalls,
        setAgent(fn) {
            agentImpl = async (msg, opts) => {
                agentCalls.push({ message: msg, threadId: opts?.threadId });
                return fn(msg, opts);
            };
        },
        setRouter(r) {
            router = r;
        },
        build() {
            return new JobExecutor(
                (msg, opts) => agentImpl(msg, opts),
                threadCleaner,
                router,
                store,
                dedup,
                presence,
                retry,
                { similarityThreshold: 0.95, similarityWindowMs: 60 * 60 * 1000 },
            );
        },
        cleanup() {
            store.stop();
            dedup.close();
            rmSync(workDir, { recursive: true, force: true });
        },
    };

    // Wire the initial agent stub through the wrapper so calls are recorded.
    harness.setAgent(async () => ({ response: 'default reply' }));
    return harness;
}

function makeJob(overrides: Partial<ExecutionJob> = {}): ExecutionJob {
    return {
        id: 'test-job',
        name: 'test',
        trigger: 'heartbeat',
        prompt: 'hello',
        deliveryMode: 'always',
        delivery: {
            channelName: 'telegram',
            peer: { id: 'u1', type: 'user' },
        },
        ...overrides,
    };
}

describe('JobExecutor — basic delivery flow', () => {
    let h: ReturnType<typeof makeHarness>;
    afterEach(() => h.cleanup());
    beforeEach(() => (h = makeHarness()));

    it('delivers in always mode and updates job stats', async () => {
        h.setAgent(async () => ({ response: 'pulse content' }));
        const exec = h.build();
        const result = await exec.execute(makeJob());

        expect(result.action).toBe('delivered');
        expect(h.sentMessages).toHaveLength(1);
        expect(h.sentMessages[0]!.text).toBe('pulse content');

        const state = await h.store.getJobState('test-job');
        expect(state.runCount).toBe(1);
        expect(state.deliveredCount).toBe(1);
        expect(state.lastStatus).toBe('success');
        expect(state.lastAction).toBe('delivered');
    });

    it('suppresses when the agent reply is empty/whitespace', async () => {
        h.setAgent(async () => ({ response: '   \n  ' }));
        const exec = h.build();
        const result = await exec.execute(makeJob());

        expect(result.action).toBe('suppressed');
        expect(h.sentMessages).toHaveLength(0);

        const state = await h.store.getJobState('test-job');
        expect(state.suppressedCount).toBe(1);
        expect(state.deliveredCount).toBe(0);
    });

    it('strips REPORTED: lines before delivery', async () => {
        h.setAgent(async () => ({
            response: 'visible body\nREPORTED: news=[https://example.com/a]\nmore body',
        }));
        const exec = h.build();
        await exec.execute(makeJob({ name: 'news-digest' }));

        expect(h.sentMessages[0]!.text).toBe('visible body\nmore body');
    });

    it('records semantic topics from the agent reply (always-mode REPORTED parsing)', async () => {
        h.setAgent(async () => ({
            response: 'body\nREPORTED: news=[https://x.com/y]',
        }));
        const exec = h.build();
        await exec.execute(makeJob({ name: 'news-feed' }));

        // markReported writes to dedupStore, not store.recentTopics — verify there.
        expect(h.dedup.isReported('news', 'https://x.com/y')).toBe(true);
    });
});

describe('JobExecutor — presence gating', () => {
    let h: ReturnType<typeof makeHarness>;
    afterEach(() => h.cleanup());
    beforeEach(() => (h = makeHarness()));

    it('suppresses when DND is active (and mode is not silent)', async () => {
        await h.presence.setExplicitStatus('dnd', 60_000, 'focus block');
        h.setAgent(async () => ({ response: 'should not deliver' }));
        const exec = h.build();
        const result = await exec.execute(makeJob());

        expect(result.action).toBe('suppressed');
        expect(h.sentMessages).toHaveLength(0);
    });

    it('suppresses during quiet hours', async () => {
        await h.presence.setQuietHours(Date.now() + 60_000);
        h.setAgent(async () => ({ response: 'should not deliver' }));
        const exec = h.build();
        const result = await exec.execute(makeJob());

        expect(result.action).toBe('suppressed');
        expect(h.sentMessages).toHaveLength(0);
    });

    it('silent mode bypasses DND (still calls agent, never delivers)', async () => {
        await h.presence.setExplicitStatus('dnd', 60_000);
        h.setAgent(async () => ({ response: 'reflection content' }));
        const exec = h.build();
        const result = await exec.execute(makeJob({ deliveryMode: 'silent' }));

        expect(result.action).toBe('suppressed');
        expect(h.agentCalls).toHaveLength(1);
        expect(h.sentMessages).toHaveLength(0);
    });
});

describe('JobExecutor — ephemeral thread lifecycle (heartbeat overflow fix)', () => {
    let h: ReturnType<typeof makeHarness>;
    afterEach(() => h.cleanup());
    beforeEach(() => (h = makeHarness()));

    it('creates an ephemeral thread when job.threadId is unset and cleans it up', async () => {
        h.setAgent(async () => ({ response: 'r' }));
        const exec = h.build();
        await exec.execute(makeJob());

        expect(h.agentCalls[0]!.threadId).toMatch(/^proactive:test-job:\d+$/);
        expect(h.cleanups).toEqual([h.agentCalls[0]!.threadId]);
    });

    it('reuses caller-supplied threadId and does NOT clean it up', async () => {
        h.setAgent(async () => ({ response: 'r' }));
        const exec = h.build();
        await exec.execute(makeJob({ threadId: 'caller-owned-thread' }));

        expect(h.agentCalls[0]!.threadId).toBe('caller-owned-thread');
        expect(h.cleanups).toEqual([]);
    });

    it('still cleans up the ephemeral thread when the agent throws', async () => {
        h.setAgent(async () => {
            throw new Error('boom');
        });
        const exec = h.build();
        const result = await exec.execute(makeJob());

        expect(result.action).toBe('error');
        // Cleanup MUST run from the finally block — otherwise a poisoned
        // thread would persist across crashes.
        expect(h.cleanups).toHaveLength(1);
        expect(h.cleanups[0]).toMatch(/^proactive:/);

        const state = await h.store.getJobState('test-job');
        expect(state.lastStatus).toBe('error');
        expect(state.consecutiveErrors).toBe(1);
        expect(state.nextBackoffMs).toBeGreaterThan(0);
    });
});

describe('JobExecutor — concurrency guard', () => {
    let h: ReturnType<typeof makeHarness>;
    afterEach(() => h.cleanup());
    beforeEach(() => (h = makeHarness()));

    it('skips a fire when the prior fire is still executing', async () => {
        let resolveFirst: (() => void) | undefined;
        h.setAgent(
            () =>
                new Promise<{ response: string }>((resolve) => {
                    resolveFirst = () => resolve({ response: 'r' });
                }),
        );
        const exec = h.build();

        const firstP = exec.execute(makeJob());
        // Yield so jobState.isExecuting is persisted before the second fire.
        await new Promise((r) => setImmediate(r));

        const secondResult = await exec.execute(makeJob());
        expect(secondResult.action).toBe('suppressed');
        expect(secondResult.durationMs).toBe(0);

        resolveFirst!();
        await firstP;
        expect(h.agentCalls).toHaveLength(1);
    });
});

describe('JobExecutor — conditional mode (legacy string-parsed JSON)', () => {
    let h: ReturnType<typeof makeHarness>;
    afterEach(() => h.cleanup());
    beforeEach(() => (h = makeHarness()));

    it('delivers when status=promote', async () => {
        h.setAgent(async () => ({
            response: JSON.stringify({
                status: 'promote',
                reason: 'fresh news',
                content: 'go read this',
            }),
        }));
        const exec = h.build();
        const result = await exec.execute(makeJob({ deliveryMode: 'conditional' }));

        expect(result.action).toBe('delivered');
        expect(h.sentMessages[0]!.text).toBe('go read this');
    });

    it('suppresses when status=suppress', async () => {
        h.setAgent(async () => ({
            response: JSON.stringify({ status: 'suppress', reason: 'nothing new' }),
        }));
        const exec = h.build();
        const result = await exec.execute(makeJob({ deliveryMode: 'conditional' }));

        expect(result.action).toBe('suppressed');
        expect(h.sentMessages).toHaveLength(0);
    });

    it('suppresses on unparseable JSON (safe default — no garbage delivery)', async () => {
        h.setAgent(async () => ({ response: 'I am not JSON' }));
        const exec = h.build();
        const result = await exec.execute(makeJob({ deliveryMode: 'conditional' }));

        expect(result.action).toBe('suppressed');
        expect(h.sentMessages).toHaveLength(0);
    });

    it('parses fenced ```json blocks (Anthropic / Llama emit these even when asked for raw)', async () => {
        h.setAgent(async () => ({
            response:
                '```json\n' +
                JSON.stringify({ status: 'promote', reason: 'r', content: 'inside fence' }) +
                '\n```',
        }));
        const exec = h.build();
        const result = await exec.execute(makeJob({ deliveryMode: 'conditional' }));

        expect(result.action).toBe('delivered');
        expect(h.sentMessages[0]!.text).toBe('inside fence');
    });
});

describe('JobExecutor — delivery transport failure', () => {
    let h: ReturnType<typeof makeHarness>;
    afterEach(() => h.cleanup());
    beforeEach(() => (h = makeHarness()));

    it('queues the job for retry when the channel is disconnected', async () => {
        await h.retry.load();
        h.setRouter(
            new ChannelRouter(
                () => false,
                async () => undefined,
            ),
        );
        h.setAgent(async () => ({ response: 'cannot send right now' }));
        const exec = h.build();
        const result = await exec.execute(makeJob());

        expect(result.action).toBe('error');
        const queue = (h.retry as unknown as { tasks: unknown[] }).tasks;
        expect(queue).toHaveLength(1);
    });
});

describe('JobExecutor — semantic dedup (recordDelivery + findSimilar)', () => {
    let h: ReturnType<typeof makeHarness>;
    afterEach(() => h.cleanup());
    beforeEach(() => (h = makeHarness()));

    it('suppresses a delivery whose embedding is too similar to a recent one', async () => {
        // Embedder returns the same vector twice → identical → similarity 1.0.
        const exec = new JobExecutor(
            (m, o) => {
                h.agentCalls.push({ message: m, threadId: o?.threadId });
                return Promise.resolve({ response: 'duplicate body' });
            },
            async (id) => {
                h.cleanups.push(id);
            },
            new ChannelRouter(
                () => true,
                async (channel, peer, text) => {
                    h.sentMessages.push({ channel, peerId: peer.id, text });
                    return 'msg-id';
                },
            ),
            h.store,
            h.dedup,
            h.presence,
            h.retry,
            {
                embedder: { embed: async () => [1, 0, 0] },
                similarityThreshold: 0.9,
                similarityWindowMs: 60 * 60 * 1000,
            },
        );

        const first = await exec.execute(makeJob({ id: 'sim-1' }));
        const second = await exec.execute(makeJob({ id: 'sim-2' }));

        expect(first.action).toBe('delivered');
        expect(second.action).toBe('suppressed');
        expect(h.sentMessages).toHaveLength(1);
    });
});

describe('parseConditionalResponse — pure helper', () => {
    it('parses raw JSON', () => {
        expect(parseConditionalResponse('{"status":"promote","reason":"r"}')).toEqual({
            status: 'promote',
            reason: 'r',
        });
    });

    it('returns null for unknown status', () => {
        expect(parseConditionalResponse('{"status":"bogus"}')).toBeNull();
    });

    it('returns null for non-JSON', () => {
        expect(parseConditionalResponse('plain prose')).toBeNull();
    });

    it('extracts JSON from ```json fenced blocks', () => {
        const out = parseConditionalResponse(
            '```json\n{"status":"suppress","reason":"q"}\n```',
        );
        expect(out).toEqual({ status: 'suppress', reason: 'q' });
    });
});
