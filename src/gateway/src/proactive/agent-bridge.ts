import { createLogger } from '@flopsy/shared';
import { buildProactiveRuntimeHints, resolveProactiveTimeoutSignal } from '@flopsy/team';
import type { AgentHandler, AgentResult } from '@gateway/types/agent';
import type { AgentCaller } from './types';
import { randomBytes } from 'node:crypto';

const log = createLogger('proactive-bridge');

export function buildAgentCaller(handler: AgentHandler): AgentCaller {
    return async function agentCaller<T = unknown>(
        message: string,
        options: {
            threadId?: string;
            personality?: string;
            deliveryMode?: 'always' | 'conditional' | 'silent';
        } = {},
    ): Promise<{ response: string; structured?: T }> {
        const threadId =
            options.threadId ??
            `proactive:${Date.now()}:${randomBytes(8).toString('hex')}`;

        let result: AgentResult;
        if (handler.invokeStateless) {
            result = await handler.invokeStateless(message, threadId, {
                ...(options.deliveryMode ? { deliveryMode: options.deliveryMode } : {}),
                ...(options.personality ? { personality: options.personality } : {}),
            });
        } else {
            let reply = '';
            const callbacks = buildCallbacks((text) => {
                reply += text;
            }, options.personality, options.deliveryMode);
            result = await handler.invoke(message, threadId, callbacks, 'user');
            result = { ...result, reply: result.reply ?? reply };
        }
        const response = result.reply ?? '';

        const TRUNC = 4000;
        const fullResponse = response.length > TRUNC
            ? `${response.slice(0, TRUNC)}\n…[+${response.length - TRUNC} chars truncated]`
            : response;
        let structuredJson: string | null = null;
        if (result.structured !== undefined) {
            try {
                structuredJson = JSON.stringify(result.structured, null, 2);
                if (structuredJson.length > TRUNC) {
                    structuredJson = `${structuredJson.slice(0, TRUNC)}\n…[truncated]`;
                }
            } catch {
                structuredJson = '<JSON.stringify failed>';
            }
        }
        log.info(
            {
                threadId,
                op: 'proactive:agent-return',
                hasStructured: result.structured !== undefined,
                responseLength: response.length,
                response: fullResponse,
                structured: structuredJson,
            },
            result.structured !== undefined
                ? 'proactive: agent returned (with structured output)'
                : 'proactive: agent returned (NO structured output — agent bypassed __respond__ or schema not wired)',
        );

        if (result.structured !== undefined) {
            return { response, structured: result.structured as T };
        }
        return { response };
    };
}

const warned = {
    setDidSendViaTool: false,
    eventQueuePush: false,
    eventQueueWait: false,
    sendPoll: false,
};

function warnOnce(key: keyof typeof warned, what: string): void {
    if (warned[key]) return;
    warned[key] = true;
    log.warn(
        { stub: key },
        `proactive-bridge stub called: ${what}. This call is a no-op. ` +
            `Workers spawned during proactive fires can't use this surface. ` +
            `If you need it, plumb a real callbacks object from the channel-worker.`,
    );
}

function buildCallbacks(
    onText: (t: string) => void,
    personality?: string,
    deliveryMode?: 'always' | 'conditional' | 'silent',
) {
    return {
        onReply: async (text: string) => {
            onText(text);
        },
        sendPoll: async () => {
            warnOnce('sendPoll', 'sendPoll() — proactive fire tried to send a poll');
        },
        drainPending: () => [] as string[],
        onProgress: () => {},
        setDidSendViaTool: () => {
            warnOnce(
                'setDidSendViaTool',
                'setDidSendViaTool() — proactive worker thinks it sent via tool, but the gateway can\'t track it',
            );
        },
        eventQueue: {
            push: () => {
                warnOnce(
                    'eventQueuePush',
                    'eventQueue.push() — proactive worker tried to enqueue an event; it will be dropped',
                );
            },
            tryDequeue: () => null,
            waitForEvent: async () => {
                warnOnce(
                    'eventQueueWait',
                    'eventQueue.waitForEvent() — proactive worker is waiting for an event that will never arrive',
                );
                return false;
            },
        },
        pending: [] as readonly string[],
        signal: resolveProactiveTimeoutSignal(),
        channelName: 'proactive',
        channelCapabilities: [] as readonly string[],
        peer: { id: 'proactive', type: 'user' as const },
        runtimeHints: buildProactiveRuntimeHints(deliveryMode),
        ...(personality ? { personality } : {}),
        ...(deliveryMode ? { deliveryMode } : {}),
    };
}

