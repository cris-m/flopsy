import { createLogger } from '@flopsy/shared';
import type {
    Interceptor as FlopsygraphInterceptor,
    InterceptorContext,
    InterceptorSessionEndContext,
    InterceptorTurnContext,
    MemoryWriteAction,
    ChatMessage,
} from 'flopsygraph';
import { redactSecrets } from './redact';

const log = createLogger('interceptor-fanout');

/**
 * Invoke `onTurnStart` on each interceptor in registration order. Hook
 * exceptions are caught and logged — one bad interceptor must NOT abort
 * the rest of the chain (the agent's turn lifecycle is non-negotiable).
 */
export async function fireTurnStart(
    interceptors: readonly FlopsygraphInterceptor[],
    ctx: InterceptorTurnContext,
): Promise<void> {
    for (const i of interceptors) {
        if (!i.onTurnStart) continue;
        try {
            await i.onTurnStart(ctx);
        } catch (err) {
            log.debug(
                { err: redactSecrets(err), name: i.name, op: 'onTurnStart' },
                'turn-start hook failed (continuing)',
            );
        }
    }
}

/**
 * Invoke `onTurnEnd` in REVERSE registration order — symmetric with
 * onTurnStart so wrappers unwind correctly (compactor must run after
 * the outer interceptors have observed the final reply).
 */
export async function fireTurnEnd(
    interceptors: readonly FlopsygraphInterceptor[],
    ctx: InterceptorTurnContext,
    finalReply: string,
): Promise<void> {
    for (let idx = interceptors.length - 1; idx >= 0; idx--) {
        const i = interceptors[idx]!;
        if (!i.onTurnEnd) continue;
        try {
            await i.onTurnEnd(ctx, finalReply);
        } catch (err) {
            log.debug(
                { err: redactSecrets(err), name: i.name, op: 'onTurnEnd' },
                'turn-end hook failed (continuing)',
            );
        }
    }
}

export async function fireSessionStart(
    interceptors: readonly FlopsygraphInterceptor[],
    threadId: string,
): Promise<void> {
    const ctx: InterceptorContext = {
        runId: `session-start-${threadId}-${Date.now()}`,
        threadId,
        configurable: {},
        store: new Map<string, unknown>(),
    };
    for (const i of interceptors) {
        if (!i.onSessionStart) continue;
        try {
            await i.onSessionStart(ctx);
        } catch (err) {
            log.debug(
                { err: redactSecrets(err), name: i.name, op: 'onSessionStart' },
                'session-start hook failed (continuing)',
            );
        }
    }
}

/**
 * Symmetric to fireTurnEnd — reverse order so unwind matches setup.
 */
export async function fireSessionEnd(
    interceptors: readonly FlopsygraphInterceptor[],
    threadId: string,
    reason: 'eviction' | 'explicit' | 'timeout',
    accumulatedMessages: readonly ChatMessage[],
): Promise<void> {
    const ctx: InterceptorSessionEndContext = {
        runId: `session-end-${threadId}-${Date.now()}`,
        threadId,
        configurable: {},
        store: new Map<string, unknown>(),
        messages: accumulatedMessages,
        reason,
    };
    for (let idx = interceptors.length - 1; idx >= 0; idx--) {
        const i = interceptors[idx]!;
        if (!i.onSessionEnd) continue;
        try {
            await i.onSessionEnd(ctx);
        } catch (err) {
            log.debug(
                { err: redactSecrets(err), name: i.name, op: 'onSessionEnd' },
                'session-end hook failed (continuing)',
            );
        }
    }
}

export async function fireDelegation(
    interceptors: readonly FlopsygraphInterceptor[],
    threadId: string,
    task: string,
    result: string,
    childSessionId: string,
): Promise<void> {
    const ctx: InterceptorContext = {
        runId: `delegation-${threadId}-${Date.now()}`,
        threadId,
        configurable: {},
        store: new Map<string, unknown>(),
    };
    for (const i of interceptors) {
        if (!i.onDelegation) continue;
        try {
            await i.onDelegation(task, result, childSessionId, ctx);
        } catch (err) {
            log.debug(
                { err: redactSecrets(err), name: i.name, op: 'onDelegation' },
                'delegation hook failed (continuing)',
            );
        }
    }
}

/**
 * Memory writes are SHARED across all threads — every interceptor in every
 * live thread gets the notification (so per-thread audit + observability
 * plugins all see the write). Caller passes the flattened list of all
 * thread-local interceptors.
 */
export async function fireMemoryWrite(
    allInterceptors: readonly (readonly FlopsygraphInterceptor[])[],
    action: MemoryWriteAction,
    target: string,
    content: string,
    metadata: Readonly<Record<string, unknown>>,
): Promise<void> {
    const ctx: InterceptorContext = {
        runId: `memory-write-${Date.now()}`,
        threadId: 'shared-memory',
        configurable: {},
        store: new Map<string, unknown>(),
    };
    for (const interceptors of allInterceptors) {
        for (const i of interceptors) {
            if (!i.onMemoryWrite) continue;
            try {
                await i.onMemoryWrite(action, target, content, metadata, ctx);
            } catch (err) {
                log.debug(
                    { err: redactSecrets(err), name: i.name, op: 'onMemoryWrite' },
                    'memory-write hook failed (continuing)',
                );
            }
        }
    }
}
