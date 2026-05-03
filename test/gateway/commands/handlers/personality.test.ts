/**
 * /personality slash command — switch the agent voice for the current session.
 *
 * Tests the user-facing render layer with a stub PersonalityFacade so we
 * exercise argument parsing, clear/reset aliases, switch logic, and the
 * panel formatting without depending on the real PersonalityRegistry +
 * SessionsTable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { personalityCommand } from '@flopsy/gateway/commands/handlers/personality';
import type { CommandContext } from '@flopsy/gateway/commands/types';
import {
    setPersonalityFacade,
    type PersonalityFacade,
    type PersonalityEntry,
} from '@flopsy/gateway/commands/personality-facade';

interface FacadeCalls {
    setActive: Array<{ rawKey: string; name: string | null }>;
    evictThread: string[];
}

function makeFacade(opts: {
    list?: PersonalityEntry[];
    active?: string | null;
    setActiveResult?: boolean;
} = {}): { facade: PersonalityFacade; calls: FacadeCalls } {
    const calls: FacadeCalls = { setActive: [], evictThread: [] };
    let active = opts.active ?? null;
    const facade: PersonalityFacade = {
        list: () => opts.list ?? [],
        getActive: () => active,
        setActive: (rawKey, name) => {
            calls.setActive.push({ rawKey, name });
            const ok = opts.setActiveResult ?? true;
            if (ok) active = name;
            return ok;
        },
        evictThread: (rawKey) => {
            calls.evictThread.push(rawKey);
        },
    };
    return { facade, calls };
}

function ctx(rawArgs: string): CommandContext {
    return {
        args: rawArgs.split(/\s+/).filter(Boolean),
        rawArgs,
        channelName: 'telegram',
        peer: { id: '1', type: 'user', name: 'tester' },
        threadId: 'telegram:dm:1#s-current',
    };
}

async function run(args: string): Promise<string> {
    const r = await personalityCommand.handler(ctx(args));
    return (r as { text: string }).text;
}

afterEach(() => {
    setPersonalityFacade(null);
});

describe('/personality — wiring', () => {
    it('warns when the facade is not set', async () => {
        const out = await run('');
        expect(out).toMatch(/not wired/i);
    });
});

describe('/personality — list', () => {
    const PERSONALITIES: PersonalityEntry[] = [
        { name: 'concise', description: 'terse, no preamble' },
        { name: 'savage', description: 'brutal honesty' },
        { name: 'tutor', description: 'explains step by step' },
    ];

    it('lists available personalities when called with no args', async () => {
        setPersonalityFacade(makeFacade({ list: PERSONALITIES }).facade);
        const out = await run('');
        expect(out).toContain('concise');
        expect(out).toContain('savage');
        expect(out).toContain('tutor');
    });

    it('marks the active personality with ● and others with ○', async () => {
        setPersonalityFacade(makeFacade({ list: PERSONALITIES, active: 'savage' }).facade);
        const out = await run('list');
        expect(out).toContain('●');
        expect(out).toContain('○');
        // Active line has the ● marker followed by the name.
        expect(out).toMatch(/●\s+savage/);
    });

    it('warns when no personalities are configured', async () => {
        setPersonalityFacade(makeFacade({ list: [] }).facade);
        const out = await run('list');
        expect(out).toMatch(/no personalities configured/i);
    });
});

describe('/personality — switch', () => {
    const PERSONALITIES: PersonalityEntry[] = [
        { name: 'concise', description: 'terse' },
        { name: 'savage', description: 'brutal' },
    ];

    it('switches to a known personality', async () => {
        const { facade, calls } = makeFacade({ list: PERSONALITIES });
        setPersonalityFacade(facade);
        const out = await run('savage');
        expect(out).toMatch(/switched to "savage"/i);
        expect(calls.setActive).toHaveLength(1);
        expect(calls.setActive[0]!.name).toBe('savage');
        // Thread evicted so the new overlay applies on next message.
        expect(calls.evictThread).toHaveLength(1);
    });

    it('reports already-active when switching to the active personality', async () => {
        const { facade, calls } = makeFacade({
            list: PERSONALITIES,
            active: 'savage',
        });
        setPersonalityFacade(facade);
        const out = await run('savage');
        expect(out).toMatch(/already on "savage"/i);
        // No setActive / evictThread calls — no-op fast path.
        expect(calls.setActive).toHaveLength(0);
        expect(calls.evictThread).toHaveLength(0);
    });

    it('renders error panel for unknown personality name', async () => {
        setPersonalityFacade(makeFacade({ list: PERSONALITIES }).facade);
        const out = await run('does-not-exist');
        // Render typically lists the known options after the error.
        expect(out).toContain('concise');
        expect(out).toContain('savage');
    });

    it('reports failure when facade.setActive returns false', async () => {
        const { facade } = makeFacade({
            list: PERSONALITIES,
            setActiveResult: false,
        });
        setPersonalityFacade(facade);
        const out = await run('savage');
        expect(out).toMatch(/could not switch/i);
    });
});

describe('/personality — reset / clear / off', () => {
    const PERSONALITIES: PersonalityEntry[] = [{ name: 'savage', description: '' }];

    it('clears via "reset"', async () => {
        const { facade, calls } = makeFacade({
            list: PERSONALITIES,
            active: 'savage',
        });
        setPersonalityFacade(facade);
        const out = await run('reset');
        expect(out).toMatch(/cleared|default/i);
        expect(calls.setActive).toHaveLength(1);
        expect(calls.setActive[0]!.name).toBeNull();
        expect(calls.evictThread).toHaveLength(1);
    });

    it('also accepts "default" / "off" / "clear" / "none" as clear aliases', async () => {
        for (const alias of ['default', 'off', 'clear', 'none']) {
            const { facade, calls } = makeFacade({
                list: PERSONALITIES,
                active: 'savage',
            });
            setPersonalityFacade(facade);
            await run(alias);
            expect(calls.setActive[0]!.name).toBeNull();
            setPersonalityFacade(null);
        }
    });

    it('reports already-on-default when clearing while no overlay is set', async () => {
        const { facade, calls } = makeFacade({
            list: PERSONALITIES,
            active: null,
        });
        setPersonalityFacade(facade);
        const out = await run('reset');
        expect(out).toMatch(/already on default/i);
        // No setActive call — fast path.
        expect(calls.setActive).toHaveLength(0);
    });
});
