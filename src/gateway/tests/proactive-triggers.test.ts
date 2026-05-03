/**
 * HeartbeatTrigger + CronTrigger — fire policy.
 *
 * The bugs that caused the SEO-snippet incident lived in the triggers, not in
 * the executor: when the prompt file was missing, the trigger swallowed the
 * ENOENT and passed an empty prompt down. The fix returns null and skips the
 * fire entirely. These tests pin that policy so it doesn't regress.
 *
 * The trigger is wired with a stub JobExecutor that records what it would
 * have run — we don't exercise the executor here (that's the executor test).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeartbeatTrigger } from '../src/proactive/triggers/heartbeat';
import { CronTrigger } from '../src/proactive/triggers/cron';
import { PromptLoader } from '../src/proactive/prompt-loader';
import type { JobExecutor } from '../src/proactive/pipeline/executor';
import type { PresenceManager } from '../src/proactive/state/presence';
import type { StateStore } from '../src/proactive/state/store';
import type {
    HeartbeatDefinition,
    JobDefinition,
    DeliveryTarget,
    ExecutionJob,
} from '../src/proactive/types';

// Minimal stubs — we only inspect what the trigger forwards.
function stubExecutor(): { calls: ExecutionJob[]; executor: JobExecutor } {
    const calls: ExecutionJob[] = [];
    const executor = {
        execute: vi.fn(async (job: ExecutionJob) => {
            calls.push(job);
            return { action: 'delivered', durationMs: 1 } as const;
        }),
    } as unknown as JobExecutor;
    return { calls, executor };
}

function stubPresence(inActiveHours = true): PresenceManager {
    return {
        isInActiveHours: vi.fn(async () => inActiveHours),
        shouldSuppress: vi.fn(async () => ({ suppress: false })),
    } as unknown as PresenceManager;
}

function stubStore(): StateStore {
    return {
        isOneshotCompleted: vi.fn(() => false),
        markOneshotCompleted: vi.fn(),
    } as unknown as StateStore;
}

const target: DeliveryTarget = {
    channelName: 'telegram',
    peer: { id: 'u1', type: 'user' },
};

describe('HeartbeatTrigger — prompt-file ENOENT skip', () => {
    let homeDir: string;
    let prevHome: string | undefined;

    beforeEach(() => {
        homeDir = mkdtempSync(join(tmpdir(), 'flopsy-hb-trig-'));
        mkdirSync(join(homeDir, 'proactive', 'heartbeats'), { recursive: true });
        prevHome = process.env.FLOPSY_HOME;
        process.env.FLOPSY_HOME = homeDir;
    });
    afterEach(() => {
        if (prevHome === undefined) delete process.env.FLOPSY_HOME;
        else process.env.FLOPSY_HOME = prevHome;
        rmSync(homeDir, { recursive: true, force: true });
    });

    it('does NOT call the executor when the prompt file is missing (anti-improvisation)', async () => {
        const loader = new PromptLoader(homeDir);
        const { calls, executor } = stubExecutor();
        const trigger = new HeartbeatTrigger(executor, stubPresence(), stubStore(), loader);

        const hb: HeartbeatDefinition = {
            name: 'pulse',
            enabled: true,
            interval: '30m',
            prompt: '',
            promptFile: 'missing.md',
            deliveryMode: 'conditional',
            delivery: target,
        };
        trigger.resolveDelivery = (o) => o ?? null;
        trigger.addHeartbeat(hb, target);

        const fired = await trigger.triggerNow('pulse');
        expect(fired).toBe(true); // trigger ran the fire path…
        expect(calls).toHaveLength(0); // …but bailed before the executor.

        trigger.stop();
    });

    it('forwards loaded prompt to the executor when the file exists', async () => {
        writeFileSync(
            join(homeDir, 'proactive', 'heartbeats', 'pulse.md'),
            'real prompt body',
            'utf8',
        );
        const loader = new PromptLoader(homeDir);
        const { calls, executor } = stubExecutor();
        const trigger = new HeartbeatTrigger(executor, stubPresence(), stubStore(), loader);

        const hb: HeartbeatDefinition = {
            name: 'pulse',
            enabled: true,
            interval: '30m',
            prompt: '',
            promptFile: 'pulse.md',
            deliveryMode: 'conditional',
            delivery: target,
        };
        trigger.resolveDelivery = (o) => o ?? null;
        trigger.addHeartbeat(hb, target);

        await trigger.triggerNow('pulse');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.prompt).toBe('real prompt body');
        expect(calls[0]!.trigger).toBe('heartbeat');
        expect(calls[0]!.deliveryMode).toBe('conditional');

        trigger.stop();
    });

    it('skips fire when activeHours window does not match', async () => {
        const loader = new PromptLoader(homeDir);
        const { calls, executor } = stubExecutor();
        const presence = stubPresence(false); // outside hours
        const trigger = new HeartbeatTrigger(executor, presence, stubStore(), loader);

        const hb: HeartbeatDefinition = {
            name: 'pulse',
            enabled: true,
            interval: '30m',
            prompt: 'inline',
            deliveryMode: 'conditional',
            activeHours: { start: 7, end: 22 },
            delivery: target,
        };
        trigger.resolveDelivery = (o) => o ?? null;
        trigger.addHeartbeat(hb, target);

        await trigger.triggerNow('pulse');
        expect(calls).toHaveLength(0);
        trigger.stop();
    });

    it('uses the threadIdResolver to keep heartbeat fires ephemeral by default', async () => {
        const loader = new PromptLoader(homeDir);
        const { calls, executor } = stubExecutor();
        const trigger = new HeartbeatTrigger(executor, stubPresence(), stubStore(), loader);
        // Resolver returning undefined is the contract that prevents the
        // 132K-token session-thread overflow seen in production.
        trigger.threadIdResolver = () => undefined;

        const hb: HeartbeatDefinition = {
            name: 'pulse',
            enabled: true,
            interval: '30m',
            prompt: 'inline',
            deliveryMode: 'always',
            delivery: target,
        };
        trigger.resolveDelivery = (o) => o ?? null;
        trigger.addHeartbeat(hb, target);

        await trigger.triggerNow('pulse');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.threadId).toBeUndefined();
        trigger.stop();
    });

    it('refuses to register a heartbeat with an invalid interval', async () => {
        const loader = new PromptLoader(homeDir);
        const { executor } = stubExecutor();
        const trigger = new HeartbeatTrigger(executor, stubPresence(), stubStore(), loader);
        const ok = trigger.addHeartbeat(
            {
                name: 'bad',
                enabled: true,
                interval: 'forever',
                prompt: 'x',
                deliveryMode: 'always',
            },
            target,
        );
        expect(ok).toBe(false);
        trigger.stop();
    });
});

describe('CronTrigger — prompt-file ENOENT skip', () => {
    let homeDir: string;
    let prevHome: string | undefined;

    beforeEach(() => {
        homeDir = mkdtempSync(join(tmpdir(), 'flopsy-cron-trig-'));
        mkdirSync(join(homeDir, 'proactive', 'cron'), { recursive: true });
        prevHome = process.env.FLOPSY_HOME;
        process.env.FLOPSY_HOME = homeDir;
    });
    afterEach(() => {
        if (prevHome === undefined) delete process.env.FLOPSY_HOME;
        else process.env.FLOPSY_HOME = prevHome;
        rmSync(homeDir, { recursive: true, force: true });
    });

    it('does NOT call the executor when the cron prompt file is missing', async () => {
        const loader = new PromptLoader(homeDir);
        const { calls, executor } = stubExecutor();
        const trigger = new CronTrigger(executor, stubStore(), loader);
        trigger.resolveDelivery = (o) => o ?? null;

        const job: JobDefinition = {
            id: 'morning',
            name: 'morning-briefing',
            enabled: true,
            schedule: { kind: 'at', atMs: Date.now() + 60_000 },
            payload: {
                promptFile: 'missing.md',
                deliveryMode: 'always',
                delivery: target,
            },
        };
        await trigger.addJob(job);
        await trigger.triggerNow('morning');

        expect(calls).toHaveLength(0);
        await trigger.stop();
    });

    it('forwards loaded cron prompt to the executor', async () => {
        writeFileSync(
            join(homeDir, 'proactive', 'cron', 'morning.md'),
            'morning brief body',
            'utf8',
        );
        const loader = new PromptLoader(homeDir);
        const { calls, executor } = stubExecutor();
        const trigger = new CronTrigger(executor, stubStore(), loader);
        trigger.resolveDelivery = (o) => o ?? null;

        const job: JobDefinition = {
            id: 'morning',
            name: 'morning-briefing',
            enabled: true,
            schedule: { kind: 'at', atMs: Date.now() + 60_000 },
            payload: {
                promptFile: 'morning.md',
                deliveryMode: 'always',
                delivery: target,
            },
        };
        await trigger.addJob(job);
        await trigger.triggerNow('morning');

        expect(calls).toHaveLength(1);
        expect(calls[0]!.prompt).toBe('morning brief body');
        expect(calls[0]!.trigger).toBe('cron');
        await trigger.stop();
    });

    it('uses static job.payload.threadId when supplied (operator override)', async () => {
        writeFileSync(
            join(homeDir, 'proactive', 'cron', 'p.md'),
            'p',
            'utf8',
        );
        const loader = new PromptLoader(homeDir);
        const { calls, executor } = stubExecutor();
        const trigger = new CronTrigger(executor, stubStore(), loader);
        trigger.resolveDelivery = (o) => o ?? null;
        // Even with a resolver that would return a value, the static payload
        // threadId wins. That contract lets ops force-pin a shared group thread.
        trigger.threadIdResolver = () => 'should-not-win';

        const job: JobDefinition = {
            id: 'pinned',
            name: 'pinned',
            enabled: true,
            schedule: { kind: 'at', atMs: Date.now() + 60_000 },
            payload: {
                promptFile: 'p.md',
                deliveryMode: 'always',
                threadId: 'group-thread-xyz',
                delivery: target,
            },
        };
        await trigger.addJob(job);
        await trigger.triggerNow('pinned');

        expect(calls[0]!.threadId).toBe('group-thread-xyz');
        await trigger.stop();
    });
});
