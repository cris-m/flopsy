/**
 * manage_schedule — agent-facing CRUD over runtime heartbeats + cron jobs.
 *
 * Covers all six operations (create, list, update, delete, disable, enable),
 * the recursion guard that blocks proactive-spawned sessions from mutating
 * schedules, and the validation rules per scheduleType / cronKind.
 *
 * Uses a fake ScheduleFacade so we exercise the tool's argument validation
 * + facade wiring without depending on the real ProactiveEngine. The
 * underlying facade-to-engine path has its own coverage in dedup-store.test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolRunContext } from 'flopsygraph';
import { manageScheduleTool } from '@flopsy/team/tools/manage-schedule';
import {
    setScheduleFacade,
    type ScheduleFacade,
} from '@flopsy/team/tools/schedule-registry';

interface RecordedCall {
    op: string;
    args: unknown[];
}

function makeFakeFacade(): {
    facade: ScheduleFacade;
    calls: RecordedCall[];
    rows: Map<string, {
        id: string;
        kind: 'heartbeat' | 'cron' | 'webhook';
        configJson: string;
        enabled: boolean;
        createdAt: number;
        createdByThread: string | null;
        createdByAgent: string | null;
    }>;
} {
    const calls: RecordedCall[] = [];
    const rows = new Map<string, {
        id: string;
        kind: 'heartbeat' | 'cron' | 'webhook';
        configJson: string;
        enabled: boolean;
        createdAt: number;
        createdByThread: string | null;
        createdByAgent: string | null;
    }>();

    const facade: ScheduleFacade = {
        addRuntimeHeartbeat: (hb, createdBy) => {
            calls.push({ op: 'addRuntimeHeartbeat', args: [hb, createdBy] });
            const id = (hb as { id?: string }).id ?? `hb-${(hb as { name: string }).name}`;
            rows.set(id, {
                id,
                kind: 'heartbeat',
                configJson: JSON.stringify(hb),
                enabled: true,
                createdAt: Date.now(),
                createdByThread: createdBy?.threadId ?? null,
                createdByAgent: createdBy?.agentName ?? null,
            });
            return true;
        },
        addRuntimeCronJob: (job, createdBy) => {
            calls.push({ op: 'addRuntimeCronJob', args: [job, createdBy] });
            rows.set(job.id, {
                id: job.id,
                kind: 'cron',
                configJson: JSON.stringify(job),
                enabled: true,
                createdAt: Date.now(),
                createdByThread: createdBy?.threadId ?? null,
                createdByAgent: createdBy?.agentName ?? null,
            });
            return true;
        },
        addRuntimeWebhook: (cfg, createdBy) => {
            calls.push({ op: 'addRuntimeWebhook', args: [cfg, createdBy] });
            rows.set(cfg.name, {
                id: cfg.name,
                kind: 'webhook',
                configJson: JSON.stringify(cfg),
                enabled: true,
                createdAt: Date.now(),
                createdByThread: createdBy?.threadId ?? null,
                createdByAgent: createdBy?.agentName ?? null,
            });
            return true;
        },
        removeRuntimeSchedule: (id) => {
            calls.push({ op: 'removeRuntimeSchedule', args: [id] });
            return rows.delete(id);
        },
        setRuntimeScheduleEnabled: (id, enabled) => {
            calls.push({ op: 'setRuntimeScheduleEnabled', args: [id, enabled] });
            const row = rows.get(id);
            if (!row) return false;
            row.enabled = enabled;
            return true;
        },
        replaceRuntimeSchedule: (id, newConfig) => {
            calls.push({ op: 'replaceRuntimeSchedule', args: [id, newConfig] });
            const row = rows.get(id);
            if (!row) return false;
            row.configJson = JSON.stringify(newConfig);
            return true;
        },
        listSchedules: () => Array.from(rows.values()),
    };

    return { facade, calls, rows };
}

function userCtx(threadId = 'telegram:dm:42'): ToolRunContext {
    return {
        configurable: { threadId, agentName: 'gandalf' } as Record<string, unknown>,
    } as ToolRunContext;
}

function proactiveCtx(): ToolRunContext {
    return {
        configurable: { threadId: 'proactive:hb:test', agentName: 'gandalf' } as Record<string, unknown>,
    } as ToolRunContext;
}

let fake: ReturnType<typeof makeFakeFacade>;
beforeEach(() => {
    fake = makeFakeFacade();
    setScheduleFacade(fake.facade);
});
afterEach(() => {
    setScheduleFacade(null);
});

describe('manage_schedule — wiring', () => {
    it('reports "not running" when no facade is set', async () => {
        setScheduleFacade(null);
        const out = await manageScheduleTool.run(
            { operation: 'list' },
            'call-1',
            userCtx(),
        );
        expect(out.output).toMatch(/not running/i);
    });
});

describe('manage_schedule — create', () => {
    it('creates a heartbeat with required fields', async () => {
        const out = await manageScheduleTool.run(
            {
                operation: 'create',
                scheduleType: 'heartbeat',
                name: 'inbox-check',
                interval: '30m',
                prompt: 'Scan inbox',
            },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/created/i);
        expect(fake.calls.find((c) => c.op === 'addRuntimeHeartbeat')).toBeDefined();
    });

    it('rejects heartbeat without interval', async () => {
        const out = await manageScheduleTool.run(
            {
                operation: 'create',
                scheduleType: 'heartbeat',
                name: 'x',
                prompt: 'x',
            },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/interval/i);
    });

    it('creates a cron "at" job (one-shot)', async () => {
        const future = Date.now() + 60_000;
        const out = await manageScheduleTool.run(
            {
                operation: 'create',
                scheduleType: 'cron',
                cronKind: 'at',
                atMs: future,
                prompt: 'remind',
                oneshot: true,
            },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/created/i);
        const call = fake.calls.find((c) => c.op === 'addRuntimeCronJob');
        expect(call).toBeDefined();
    });

    it('rejects cron "at" with past timestamp', async () => {
        const out = await manageScheduleTool.run(
            {
                operation: 'create',
                scheduleType: 'cron',
                cronKind: 'at',
                atMs: Date.now() - 60_000,
                prompt: 'remind',
            },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/future/i);
    });

    it('rejects cron "every" with everyMs below 60_000', async () => {
        // Schema enforces min 60_000 — surfaces as a tool execute error;
        // depending on flopsygraph version the result is a Zod-style message.
        const out = await manageScheduleTool.run(
            {
                operation: 'create',
                scheduleType: 'cron',
                cronKind: 'every',
                everyMs: 30_000,
                prompt: 'x',
            },
            'c1',
            userCtx(),
        );
        // Either Zod's "min 60000" or the tool's own validation message.
        expect(out.output).toMatch(/60000|min/i);
    });

    it('rejects cron "cron" without expression', async () => {
        const out = await manageScheduleTool.run(
            {
                operation: 'create',
                scheduleType: 'cron',
                cronKind: 'cron',
                prompt: 'x',
            },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/cronExpr/i);
    });

    it('rejects create without prompt or promptFile', async () => {
        const out = await manageScheduleTool.run(
            {
                operation: 'create',
                scheduleType: 'heartbeat',
                name: 'x',
                interval: '1h',
            },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/prompt/i);
    });

    it('threads createdBy provenance through the facade', async () => {
        await manageScheduleTool.run(
            {
                operation: 'create',
                scheduleType: 'heartbeat',
                name: 'p',
                interval: '1h',
                prompt: 'x',
            },
            'c1',
            userCtx('telegram:dm:7'),
        );
        const call = fake.calls.find((c) => c.op === 'addRuntimeHeartbeat')!;
        const createdBy = call.args[1] as { threadId?: string; agentName?: string };
        expect(createdBy.threadId).toBe('telegram:dm:7');
        expect(createdBy.agentName).toBe('gandalf');
    });
});

describe('manage_schedule — list / delete / disable / enable', () => {
    beforeEach(async () => {
        await manageScheduleTool.run(
            {
                operation: 'create',
                scheduleType: 'heartbeat',
                name: 'A',
                interval: '1h',
                prompt: 'x',
            },
            'c0',
            userCtx(),
        );
    });

    it('lists existing schedules', async () => {
        const out = await manageScheduleTool.run(
            { operation: 'list' },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/Runtime schedules/i);
    });

    it('list returns "no schedules" when empty', async () => {
        // Re-create with empty rows
        fake.rows.clear();
        const out = await manageScheduleTool.run(
            { operation: 'list' },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/No runtime schedules/i);
    });

    it('delete needs an id', async () => {
        const out = await manageScheduleTool.run(
            { operation: 'delete' },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/Missing required field: id/i);
    });

    it('delete reports "no runtime schedule" on unknown id', async () => {
        const out = await manageScheduleTool.run(
            { operation: 'delete', id: 'no-such' },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/no runtime schedule/i);
    });

    it('disable toggles via facade', async () => {
        // The fake stored "hb-A" as id.
        const out = await manageScheduleTool.run(
            { operation: 'disable', id: 'hb-A' },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/disabled/i);
        expect(fake.rows.get('hb-A')!.enabled).toBe(false);
    });

    it('enable toggles back on', async () => {
        await manageScheduleTool.run(
            { operation: 'disable', id: 'hb-A' },
            'c0',
            userCtx(),
        );
        const out = await manageScheduleTool.run(
            { operation: 'enable', id: 'hb-A' },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/enabled/i);
        expect(fake.rows.get('hb-A')!.enabled).toBe(true);
    });
});

describe('manage_schedule — update', () => {
    beforeEach(async () => {
        await manageScheduleTool.run(
            {
                operation: 'create',
                scheduleType: 'heartbeat',
                name: 'briefing',
                interval: '1h',
                prompt: 'old prompt',
            },
            'c0',
            userCtx(),
        );
    });

    it('rejects update without id', async () => {
        const out = await manageScheduleTool.run(
            { operation: 'update', interval: '30m' },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/Missing required field: id/i);
    });

    it('rejects update of unknown id', async () => {
        const out = await manageScheduleTool.run(
            { operation: 'update', id: 'unknown', interval: '30m' },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/no runtime schedule/i);
    });

    it('updates the interval on an existing heartbeat via replaceRuntimeSchedule', async () => {
        const out = await manageScheduleTool.run(
            { operation: 'update', id: 'hb-briefing', interval: '30m' },
            'c1',
            userCtx(),
        );
        expect(out.output).toMatch(/updated/i);
        // The replaceRuntimeSchedule call carries the merged config; confirm
        // both that it was called and that `interval` is the patched value.
        const replaceCall = fake.calls.find((c) => c.op === 'replaceRuntimeSchedule');
        expect(replaceCall).toBeDefined();
        const newConfig = replaceCall!.args[1] as { interval?: string };
        expect(newConfig.interval).toBe('30m');
    });

    it('preserves fields the patch did not touch', async () => {
        // Update only the prompt; interval should stay 1h from the original.
        await manageScheduleTool.run(
            { operation: 'update', id: 'hb-briefing', prompt: 'new prompt' },
            'c1',
            userCtx(),
        );
        const replaceCall = fake.calls.find((c) => c.op === 'replaceRuntimeSchedule');
        const cfg = replaceCall!.args[1] as { interval?: string; prompt?: string };
        expect(cfg.interval).toBe('1h');
        expect(cfg.prompt).toBe('new prompt');
    });
});

describe('manage_schedule — recursion guard', () => {
    it('blocks create from a proactive-invoked thread', async () => {
        const out = await manageScheduleTool.run(
            {
                operation: 'create',
                scheduleType: 'heartbeat',
                name: 'x',
                interval: '1h',
                prompt: 'x',
            },
            'c1',
            proactiveCtx(),
        );
        expect(out.output).toMatch(/Refused.*proactive/i);
        expect(fake.calls.find((c) => c.op === 'addRuntimeHeartbeat')).toBeUndefined();
    });

    it('blocks delete from a proactive-invoked thread', async () => {
        const out = await manageScheduleTool.run(
            { operation: 'delete', id: 'x' },
            'c1',
            proactiveCtx(),
        );
        expect(out.output).toMatch(/Refused.*proactive/i);
    });

    it('blocks disable / enable / update from a proactive-invoked thread', async () => {
        for (const operation of ['disable', 'enable', 'update'] as const) {
            const out = await manageScheduleTool.run(
                { operation, id: 'x' },
                'c1',
                proactiveCtx(),
            );
            expect(out.output).toMatch(/Refused.*proactive/i);
        }
    });

    it('still allows list from a proactive-invoked thread', async () => {
        // Read-only ops should pass through so proactive sessions can introspect.
        const out = await manageScheduleTool.run(
            { operation: 'list' },
            'c1',
            proactiveCtx(),
        );
        // Either "No runtime schedules" or a list — both are non-refusal answers.
        expect(out.output).not.toMatch(/Refused.*proactive/i);
    });
});
