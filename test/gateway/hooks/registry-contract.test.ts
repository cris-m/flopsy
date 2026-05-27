import { describe, it, expect, beforeEach } from 'vitest';
import {
    HookRegistry,
    BLOCK_CAPABLE_EVENTS,
    type HookHandler,
    type HookResult,
    type RegisteredHook,
} from '../../../src/gateway/src/hooks';

function tsHook(id: string, events: string[], handle: HookHandler): RegisteredHook {
    return {
        id,
        kind: 'ts',
        absDir: '/tmp/' + id,
        handler: handle,
        config: { name: id, events, enabled: true },
    };
}

describe('HookRegistry — return-value contract', () => {
    let reg: HookRegistry;

    beforeEach(() => {
        reg = new HookRegistry();
    });

    it('emit() runs observation hooks in parallel batches and ignores returns', async () => {
        const fired: string[] = [];
        reg.setHooks([
            tsHook('a', ['turn.assistant.completed'], async () => {
                await new Promise((r) => setTimeout(r, 5));
                fired.push('a');
            }),
            tsHook('b', ['turn.assistant.completed'], () => {
                fired.push('b');
                return { action: 'block', message: 'IGNORED' };
            }),
            tsHook('c', ['turn.assistant.completed'], () => {
                fired.push('c');
            }),
        ]);

        reg.emit('turn.assistant.completed', { peerId: 'p1' });
        await new Promise((r) => setTimeout(r, 30));
        expect(fired.sort()).toEqual(['a', 'b', 'c']);
    });

    it('emitAwait() runs block-capable hooks serially and short-circuits on block', async () => {
        const fired: string[] = [];
        reg.setHooks([
            tsHook('first', ['turn.user.received'], () => {
                fired.push('first');
            }),
            tsHook('second', ['turn.user.received'], () => {
                fired.push('second');
                return { action: 'block', message: 'nope' };
            }),
            tsHook('third', ['turn.user.received'], () => {
                fired.push('third');
            }),
        ]);

        const result = await reg.emitAwait('turn.user.received', { peerId: 'p1' });
        expect(fired).toEqual(['first', 'second']);
        expect(result.blocked).toEqual({ hookId: 'second', message: 'nope' });
    });

    it('emitAwait() accumulates {context} returns from multiple hooks', async () => {
        reg.setHooks([
            tsHook('ctx1', ['memory.fact.ingested'], () => ({ context: 'alpha' })),
            tsHook('ctx2', ['memory.fact.ingested'], () => ({ context: 'beta' })),
            tsHook('noop', ['memory.fact.ingested'], () => undefined),
        ]);

        const result = await reg.emitAwait('memory.fact.ingested', { peerId: 'p1' });
        expect(result.blocked).toBeNull();
        expect(result.contexts).toEqual(['alpha', 'beta']);
    });

    it('emitAwait() returns empty aggregate when no hooks match', async () => {
        reg.setHooks([]);
        const result = await reg.emitAwait('skill.proposed', { peerId: 'p1' });
        expect(result.blocked).toBeNull();
        expect(result.contexts).toEqual([]);
    });

    it('a thrown handler does not break the chain in emitAwait()', async () => {
        const fired: string[] = [];
        reg.setHooks([
            tsHook('thrower', ['skill.proposed'], () => {
                fired.push('thrower');
                throw new Error('boom');
            }),
            tsHook('survivor', ['skill.proposed'], () => {
                fired.push('survivor');
            }),
        ]);

        const result = await reg.emitAwait('skill.proposed', { peerId: 'p1' });
        expect(fired).toEqual(['thrower', 'survivor']);
        expect(result.blocked).toBeNull();
    });

    it('event glob (suffix .*) matches subscribers', async () => {
        const fired: string[] = [];
        reg.setHooks([
            tsHook('catchall', ['turn.*'], () => {
                fired.push('catchall');
            }),
        ]);

        reg.emit('turn.assistant.completed', { peerId: 'p1' });
        reg.emit('turn.user.received', { peerId: 'p1' });
        await new Promise((r) => setTimeout(r, 10));
        expect(fired.length).toBe(2);
    });

    it('block-capable event set covers exactly the events with awaited emit sites', () => {
        // Only events where the emit site uses `emitHookAwait` and honors the
        // result belong here. turn.user.received fires POST-turn (observation),
        // turn.assistant.completed / goal.* are inherently post-events.
        expect(BLOCK_CAPABLE_EVENTS.has('memory.fact.ingested')).toBe(true);
        expect(BLOCK_CAPABLE_EVENTS.has('skill.proposed')).toBe(true);
        expect(BLOCK_CAPABLE_EVENTS.has('turn.user.received')).toBe(false);
        expect(BLOCK_CAPABLE_EVENTS.has('turn.assistant.completed')).toBe(false);
        expect(BLOCK_CAPABLE_EVENTS.has('goal.done')).toBe(false);
        expect(BLOCK_CAPABLE_EVENTS.has('goal.paused')).toBe(false);
    });

    it('HookResult type permits all 3 shapes', () => {
        const r1: HookResult = undefined;
        const r2: HookResult = { action: 'block' };
        const r3: HookResult = { action: 'block', message: 'why' };
        const r4: HookResult = { context: 'extra info' };
        expect([r1, r2, r3, r4]).toHaveLength(4);
    });
});
