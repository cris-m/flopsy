import { describe, it, expect } from 'vitest';
import { teamCommand } from '@flopsy/gateway/commands/handlers/team';
import type { CommandContext, ThreadStatus } from '@flopsy/gateway/commands/types';

function ctx(thread?: Partial<ThreadStatus>): CommandContext {
    return {
        args: [],
        rawArgs: '',
        channelName: 'telegram',
        peer: { id: '1', type: 'user' as const, name: 'tester' },
        threadId: 't#s',
        ...(thread ? { threadStatus: thread as ThreadStatus } : {}),
    };
}

async function run(c: CommandContext): Promise<string> {
    const r = await teamCommand.handler(c);
    return (r as { text: string }).text;
}

describe('/team — panel rendering', () => {
    it('renders TEAM header summary with leader + counts', async () => {
        const out = await run(
            ctx({
                threadId: 't',
                entryAgent: 'gandalf',
                activeTasks: [],
                recentTasks: [],
                team: [
                    { name: 'legolas', type: 'worker', enabled: true, status: 'idle' },
                    { name: 'gimli', type: 'worker', enabled: true, status: 'running' },
                    { name: 'saruman', type: 'worker', enabled: false, status: 'disabled' },
                ],
            }),
        );
        expect(out).toContain('TEAM');
        expect(out).toContain('gandalf');
        expect(out).toContain('2/3 enabled');
        expect(out).toContain('1 working');
    });

    it('places disabled members in their own section', async () => {
        const out = await run(
            ctx({
                threadId: 't',
                entryAgent: 'gandalf',
                activeTasks: [],
                recentTasks: [],
                team: [
                    { name: 'legolas', type: 'worker', enabled: true, status: 'idle' },
                    { name: 'saruman', type: 'worker', enabled: false, status: 'disabled' },
                ],
            }),
        );
        expect(out).toContain('◆ DISABLED');
        expect(out).toContain('saruman');
    });

    it('handles empty team gracefully', async () => {
        const out = await run(ctx());
        expect(out).toContain('TEAM');
        expect(out).toContain('no team configured');
    });

    it('uses ● / ○ for working/idle, not 🔵 / 💤', async () => {
        const out = await run(
            ctx({
                threadId: 't',
                entryAgent: 'gandalf',
                activeTasks: [],
                recentTasks: [],
                team: [
                    { name: 'legolas', type: 'worker', enabled: true, status: 'idle' },
                    { name: 'gimli', type: 'worker', enabled: true, status: 'running' },
                ],
            }),
        );
        expect(out).toContain('●');
        expect(out).toContain('○');
        expect(out).not.toContain('🔵');
        expect(out).not.toContain('💤');
    });
});
