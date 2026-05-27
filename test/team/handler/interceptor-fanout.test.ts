import { describe, it, expect } from 'vitest';
import type {
    Interceptor as FlopsygraphInterceptor,
    InterceptorTurnContext,
    InterceptorContext,
} from 'flopsygraph';
import {
    fireTurnStart,
    fireTurnEnd,
    fireSessionStart,
    fireSessionEnd,
    fireDelegation,
    fireMemoryWrite,
} from '../../../src/team/src/handler/interceptor-fanout';

function turnCtx(threadId = 't1'): InterceptorTurnContext {
    return {
        runId: 'run-1',
        threadId,
        configurable: {},
        store: new Map<string, unknown>(),
        messages: [],
        turn: 1,
    } as unknown as InterceptorTurnContext;
}

function mockInterceptor(
    name: string,
    impl: Partial<FlopsygraphInterceptor> = {},
): FlopsygraphInterceptor {
    return { name, ...impl } as FlopsygraphInterceptor;
}

describe('interceptor fanout', () => {
    it('fireTurnStart invokes onTurnStart in registration order', async () => {
        const order: string[] = [];
        await fireTurnStart(
            [
                mockInterceptor('a', { onTurnStart: async () => { order.push('a'); } }),
                mockInterceptor('b', { onTurnStart: async () => { order.push('b'); } }),
                mockInterceptor('c', { onTurnStart: async () => { order.push('c'); } }),
            ],
            turnCtx(),
        );
        expect(order).toEqual(['a', 'b', 'c']);
    });

    it('fireTurnEnd invokes onTurnEnd in REVERSE order', async () => {
        const order: string[] = [];
        await fireTurnEnd(
            [
                mockInterceptor('a', { onTurnEnd: async () => { order.push('a'); } }),
                mockInterceptor('b', { onTurnEnd: async () => { order.push('b'); } }),
                mockInterceptor('c', { onTurnEnd: async () => { order.push('c'); } }),
            ],
            turnCtx(),
            'final',
        );
        expect(order).toEqual(['c', 'b', 'a']);
    });

    it('a thrown hook does not abort the chain', async () => {
        const calls: string[] = [];
        await fireTurnStart(
            [
                mockInterceptor('thrower', {
                    onTurnStart: async () => { calls.push('thrower'); throw new Error('boom'); },
                }),
                mockInterceptor('survivor', {
                    onTurnStart: async () => { calls.push('survivor'); },
                }),
            ],
            turnCtx(),
        );
        expect(calls).toEqual(['thrower', 'survivor']);
    });

    it('skips interceptors with no onTurnStart', async () => {
        const calls: string[] = [];
        await fireTurnStart(
            [
                mockInterceptor('no-hook'),
                mockInterceptor('has-hook', { onTurnStart: async () => { calls.push('ran'); } }),
            ],
            turnCtx(),
        );
        expect(calls).toEqual(['ran']);
    });

    it('fireSessionStart passes a fresh InterceptorContext', async () => {
        let captured: InterceptorContext | null = null;
        await fireSessionStart(
            [
                mockInterceptor('a', {
                    onSessionStart: async (ctx) => { captured = ctx; },
                }),
            ],
            'thread-xyz',
        );
        expect(captured).not.toBeNull();
        expect(captured!.threadId).toBe('thread-xyz');
        expect(captured!.runId.startsWith('session-start-thread-xyz-')).toBe(true);
    });

    it('fireSessionEnd runs in REVERSE order and forwards accumulated messages', async () => {
        const order: string[] = [];
        let capturedMessages: unknown = null;
        await fireSessionEnd(
            [
                mockInterceptor('a', {
                    onSessionEnd: async (ctx) => { order.push('a'); capturedMessages = ctx.messages; },
                }),
                mockInterceptor('b', { onSessionEnd: async () => { order.push('b'); } }),
            ],
            'thread-1',
            'eviction',
            [{ role: 'user', content: 'hi' }],
        );
        expect(order).toEqual(['b', 'a']);
        expect(capturedMessages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('fireDelegation forwards task + result + childSessionId', async () => {
        const captured: Array<{ task: string; result: string; child: string }> = [];
        await fireDelegation(
            [
                mockInterceptor('a', {
                    onDelegation: async (task, result, childId) => {
                        captured.push({ task, result, child: childId });
                    },
                }),
            ],
            'parent-thread',
            'do X',
            'Y done',
            'child-session-1',
        );
        expect(captured).toEqual([{ task: 'do X', result: 'Y done', child: 'child-session-1' }]);
    });

    it('fireMemoryWrite iterates all thread-local interceptor lists', async () => {
        const calls: string[] = [];
        const list1 = [mockInterceptor('p1', { onMemoryWrite: async () => { calls.push('p1'); } })];
        const list2 = [
            mockInterceptor('p2a', { onMemoryWrite: async () => { calls.push('p2a'); } }),
            mockInterceptor('p2b', { onMemoryWrite: async () => { calls.push('p2b'); } }),
        ];
        await fireMemoryWrite([list1, list2], 'add', 'memory', 'content', {});
        expect(calls).toEqual(['p1', 'p2a', 'p2b']);
    });

    it('fireMemoryWrite swallows individual thrower without breaking later ones', async () => {
        const calls: string[] = [];
        await fireMemoryWrite(
            [
                [
                    mockInterceptor('thrower', {
                        onMemoryWrite: async () => { calls.push('thrower'); throw new Error('x'); },
                    }),
                    mockInterceptor('survivor', {
                        onMemoryWrite: async () => { calls.push('survivor'); },
                    }),
                ],
            ],
            'add',
            'mem',
            'c',
            {},
        );
        expect(calls).toEqual(['thrower', 'survivor']);
    });
});
