import { describe, it, expect } from 'vitest';
import { doctorCommand } from '@flopsy/gateway/commands/handlers/doctor';
import type { CommandContext, GatewayStatusSnapshot } from '@flopsy/gateway/commands/types';

function ctx(g?: Partial<GatewayStatusSnapshot>): CommandContext {
    return {
        args: [],
        rawArgs: '',
        channelName: 'telegram',
        peer: { id: '1', type: 'user' as const, name: 't' },
        threadId: 't#s',
        ...(g ? { gatewayStatus: g as GatewayStatusSnapshot } : {}),
    };
}

async function run(c: CommandContext): Promise<string> {
    return ((await doctorCommand.handler(c)) as { text: string }).text;
}

describe('/doctor — panel rendering', () => {
    it('shows all-clear when no issues', async () => {
        const out = await run(
            ctx({
                running: true,
                host: '127.0.0.1',
                port: 0,
                channels: [{ name: 'telegram', enabled: true, status: 'connected' }],
            } as GatewayStatusSnapshot),
        );
        expect(out).toContain('DOCTOR');
        expect(out).toContain('all systems operational');
        expect(out).toContain('✓');
    });

    it('flags channel error and includes remediation hint', async () => {
        const out = await run(
            ctx({
                running: true,
                host: '127.0.0.1',
                port: 0,
                channels: [
                    { name: 'telegram', enabled: true, status: 'connected' },
                    { name: 'discord', enabled: true, status: 'error' },
                ],
            } as GatewayStatusSnapshot),
        );
        expect(out).toContain('◆ ERRORS');
        expect(out).toContain('channel.discord');
        expect(out).toContain('connection error');
        expect(out).toContain('↳');
    });

    it('separates errors from warnings into different sections', async () => {
        const out = await run(
            ctx({
                running: true,
                host: '127.0.0.1',
                port: 0,
                channels: [
                    { name: 'telegram', enabled: true, status: 'error' },
                    { name: 'discord', enabled: true, status: 'connecting' },
                ],
            } as GatewayStatusSnapshot),
        );
        expect(out).toContain('◆ ERRORS');
        expect(out).toContain('◆ WARNINGS');
    });

    it('uses ✗ / ! glyphs, no ❌ ⚠️', async () => {
        const out = await run(
            ctx({
                running: true,
                host: '127.0.0.1',
                port: 0,
                channels: [{ name: 'telegram', enabled: true, status: 'error' }],
            } as GatewayStatusSnapshot),
        );
        expect(out).not.toContain('❌');
        expect(out).not.toContain('⚠️');
    });
});
