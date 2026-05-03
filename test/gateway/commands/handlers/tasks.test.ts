import { describe, it, expect } from 'vitest';
import { tasksCommand } from '@flopsy/gateway/commands/handlers/tasks';
import type { CommandContext, ThreadStatus, TaskSummary } from '@flopsy/gateway/commands/types';

function ctx(thread?: Partial<ThreadStatus>): CommandContext {
    return {
        args: [],
        rawArgs: '',
        channelName: 'telegram',
        peer: { id: '1', type: 'user' as const, name: 't' },
        threadId: 't#s',
        ...(thread ? { threadStatus: thread as ThreadStatus } : {}),
    };
}

async function run(c: CommandContext): Promise<string> {
    return ((await tasksCommand.handler(c)) as { text: string }).text;
}

describe('/tasks — panel rendering', () => {
    it('shows idle when nothing active or recent', async () => {
        const out = await run(ctx({ threadId: 't', entryAgent: 'g', activeTasks: [], recentTasks: [] }));
        expect(out).toContain('TASKS');
        expect(out).toContain('idle');
    });

    it('renders active section with running tasks', async () => {
        const active: TaskSummary[] = [
            {
                id: 'bg-a',
                worker: 'legolas',
                description: 'fetch news headlines',
                status: 'running',
                startedAtMs: Date.now() - 5000,
            },
        ];
        const out = await run(ctx({ threadId: 't', entryAgent: 'g', activeTasks: active, recentTasks: [] }));
        expect(out).toContain('◆ ACTIVE');
        expect(out).toContain('legolas');
        expect(out).toContain('fetch news');
        expect(out).toContain('1 active');
    });

    it('renders recent section with completed/failed glyph', async () => {
        const recent: TaskSummary[] = [
            { id: 'r1', worker: 'gimli', description: 'analyze', status: 'completed', startedAtMs: Date.now() - 60_000, endedAtMs: Date.now() - 30_000 },
            { id: 'r2', worker: 'saruman', description: 'research', status: 'failed', startedAtMs: Date.now() - 60_000, endedAtMs: Date.now() - 30_000, error: 'timeout' },
        ];
        const out = await run(ctx({ threadId: 't', entryAgent: 'g', activeTasks: [], recentTasks: recent }));
        expect(out).toContain('◆ RECENT');
        expect(out).toContain('✓');
        expect(out).toContain('✗');
        expect(out).toContain('timeout');
    });

    it('uses ● / ✓ / ✗ glyphs only — never rainbow icons', async () => {
        const recent: TaskSummary[] = [
            { id: 'r', worker: 'g', description: 'd', status: 'completed', startedAtMs: 0, endedAtMs: 0 },
        ];
        const out = await run(ctx({ threadId: 't', entryAgent: 'g', activeTasks: [], recentTasks: recent }));
        expect(out).not.toMatch(/▶️|⏸️|⏳|✅|❌|🛑/);
    });
});
