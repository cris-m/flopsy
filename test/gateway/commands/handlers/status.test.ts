/**
 * /status — chat-side status panel rendering.
 *
 * Verifies the panel structure (◆ section headers, semantic glyphs, no
 * rainbow emoji), and that key data points round-trip from snapshot to
 * rendered text.
 */
import { describe, it, expect } from 'vitest';
import { statusCommand } from '@flopsy/gateway/commands/handlers/status';
import type {
    CommandContext,
    GatewayStatusSnapshot,
    ThreadStatus,
} from '@flopsy/gateway/commands/types';

function ctxWith(opts: {
    gateway?: Partial<GatewayStatusSnapshot>;
    thread?: Partial<ThreadStatus>;
}): CommandContext {
    return {
        args: [],
        rawArgs: '',
        channelName: 'telegram',
        peer: { id: '1', type: 'user' as const, name: 'tester' },
        threadId: 'telegram:dm:1#s-1',
        ...(opts.gateway ? { gatewayStatus: opts.gateway as GatewayStatusSnapshot } : {}),
        ...(opts.thread ? { threadStatus: opts.thread as ThreadStatus } : {}),
    };
}

async function run(ctx: CommandContext): Promise<string> {
    const result = await statusCommand.handler(ctx);
    return (result as { text: string }).text;
}

describe('/status — panel rendering', () => {
    it('renders inside a fenced code block (monospace in Telegram/Discord)', async () => {
        const out = await run(ctxWith({}));
        expect(out.startsWith('```')).toBe(true);
        expect(out.trimEnd().endsWith('```')).toBe(true);
    });

    it('uses ◆ section headers, never bare bold or rainbow emoji', async () => {
        const out = await run(
            ctxWith({
                gateway: {
                    running: true,
                    host: '127.0.0.1',
                    port: 0,
                    uptimeMs: 60_000,
                    activeThreads: 1,
                    channels: [{ name: 'telegram', enabled: true, status: 'connected' }],
                } as GatewayStatusSnapshot,
            }),
        );
        expect(out).toContain('◆ GATEWAY');
        expect(out).toContain('◆ CHANNELS');
        // Anti-regression: rainbow markers banished.
        expect(out).not.toMatch(/🟢|🟡|🔴|💤|🔵|⚪|⏰|🪝/);
    });

    it('uses ✓ / ✗ for channel state, not 🟢 / 🔴', async () => {
        const out = await run(
            ctxWith({
                gateway: {
                    running: true,
                    host: '127.0.0.1',
                    port: 0,
                    channels: [
                        { name: 'telegram', enabled: true, status: 'connected' },
                        { name: 'discord', enabled: true, status: 'error' },
                        { name: 'whatsapp', enabled: false, status: 'disabled' },
                    ],
                } as GatewayStatusSnapshot,
            }),
        );
        expect(out).toContain('telegram');
        expect(out).toContain('✓');
        expect(out).toContain('✗');
        expect(out).not.toContain('🟢');
        expect(out).not.toContain('🔴');
    });

    it('renders team section with role indicators', async () => {
        const out = await run(
            ctxWith({
                thread: {
                    threadId: 't',
                    entryAgent: 'gandalf',
                    activeTasks: [],
                    recentTasks: [],
                    team: [
                        { name: 'legolas', type: 'worker', enabled: true, status: 'idle' },
                        { name: 'gimli', type: 'worker', enabled: true, status: 'running', currentTask: { id: 't1', description: 'fetch', runningMs: 1000 } },
                    ],
                } as ThreadStatus,
            }),
        );
        expect(out).toContain('◆ TEAM');
        expect(out).toContain('legolas');
        expect(out).toContain('gimli');
        expect(out).toContain('working');
        expect(out).toContain('idle');
    });

    it('renders STATUS header with entry agent + uptime', async () => {
        const out = await run(
            ctxWith({
                gateway: {
                    running: true,
                    host: '127.0.0.1',
                    port: 0,
                    uptimeMs: 3_600_000,
                } as GatewayStatusSnapshot,
                thread: {
                    threadId: 't',
                    entryAgent: 'gandalf',
                    activeTasks: [],
                    recentTasks: [],
                } as ThreadStatus,
            }),
        );
        expect(out).toContain('STATUS');
        expect(out).toContain('gandalf');
    });

    it('handles missing gateway snapshot without crashing', async () => {
        const out = await run(ctxWith({}));
        expect(out).toContain('◆ GATEWAY');
        expect(out).toContain('not running');
    });
});
