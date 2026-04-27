import type { AgentHandler } from '@gateway/types/agent';
import type { AgentCaller } from './types';

/**
 * Wraps a TeamHandler (AgentHandler) into the AgentCaller interface the
 * proactive engine uses. Each call creates a minimal callbacks object that
 * collects the agent's reply, then returns it.
 *
 * When options.responseSchema is provided, attempts to JSON-parse the reply
 * and validate it against the schema. Structured output only works if the
 * agent's prompt instructs it to respond in JSON.
 */
export function buildAgentCaller(handler: AgentHandler): AgentCaller {
    return async function agentCaller<T = unknown>(
        message: string,
        options: {
            threadId?: string;
            responseSchema?: { parse(data: unknown): T };
        } = {},
    ): Promise<{ response: string; structured?: T }> {
        const threadId =
            options.threadId ??
            `proactive:${Date.now()}:${Math.random().toString(36).slice(2)}`;

        let reply = '';
        const callbacks = buildCallbacks((text) => {
            reply += text;
        });

        const result = await handler.invoke(message, threadId, callbacks, 'system');
        const response = result.reply ?? reply;

        if (options.responseSchema && response.trim()) {
            try {
                const raw = extractJson(response);
                const structured = options.responseSchema.parse(raw);
                return { response, structured };
            } catch {
                // Agent didn't return valid JSON — fall through
            }
        }

        return { response };
    };
}

function buildCallbacks(onText: (t: string) => void) {
    return {
        onReply: async (text: string) => {
            onText(text);
        },
        sendPoll: async () => {},
        drainPending: () => [] as string[],
        onProgress: () => {},
        setDidSendViaTool: () => {},
        eventQueue: {
            push: () => {},
            tryDequeue: () => null,
            waitForEvent: async () => false,
        },
        pending: [] as readonly string[],
        signal: AbortSignal.timeout(300_000),
        channelName: 'proactive',
        channelCapabilities: [] as readonly string[],
        peer: { id: 'proactive', type: 'user' as const },
    };
}

function extractJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (match?.[1]) {
            return JSON.parse(match[1]);
        }
        throw new SyntaxError('No valid JSON found');
    }
}
