import { createLogger } from '@flopsy/shared';
import { structuredLLM, type BaseChatModel } from 'flopsygraph';
import type { ZodSchema } from 'zod';
import type { AgentHandler } from '@gateway/types/agent';
import type { AgentCaller } from './types';

const log = createLogger('proactive-bridge');

/**
 * Build the agent caller used by the proactive engine.
 *
 * Two paths, picked at call time:
 *
 * 1. **Structured-output path** — when both a `responseSchema` is provided
 *    AND a `structuredOutputModel` is configured. We call
 *    `structuredLLM(model, schema).invoke(...)` directly, bypassing the
 *    team agent. The schema travels through the provider's native
 *    structured-output mechanism (OpenAI `response_format: json_schema`,
 *    Anthropic forced `tool_choice`, Google `responseSchema`, etc.) so
 *    the model is FORCED to emit schema-valid output. This is the path
 *    used by all current proactive surfaces (smart-pulse, morning-
 *    briefing, evening-recap, weekly-review).
 *
 * 2. **Team-agent path** — when no `responseSchema` is provided OR no
 *    structured model is configured. Falls back to the legacy flow:
 *    invoke the team handler (with full tool access), let it return free
 *    text, post-hoc parse JSON if the caller asked for a schema. Kept
 *    for backward compat and for surfaces that genuinely need mid-fire
 *    tool calls.
 *
 * The structured-output path is what fixes the "agent emitted prose
 * instead of JSON" failure mode. See the executor's reformatter logic
 * for context — that path was the band-aid; this is the actual fix.
 */
export function buildAgentCaller(
    handler: AgentHandler,
    structuredOutputModel?: BaseChatModel | null,
): AgentCaller {
    return async function agentCaller<T = unknown>(
        message: string,
        options: {
            threadId?: string;
            responseSchema?: { parse(data: unknown): T };
            personality?: string;
        } = {},
    ): Promise<{ response: string; structured?: T }> {
        const threadId =
            options.threadId ??
            `proactive:${Date.now()}:${Math.random().toString(36).slice(2)}`;

        // Path 1 — provider-enforced structured output.
        // Skip the team graph, hit the model directly with the schema bound.
        if (options.responseSchema && structuredOutputModel) {
            try {
                const llm = structuredLLM(
                    structuredOutputModel,
                    options.responseSchema as unknown as ZodSchema<T>,
                );
                const result = await llm.invoke([
                    { role: 'user', content: message },
                ]);
                if (result.ok) {
                    log.info(
                        {
                            threadId,
                            attempts: result.attempts,
                            structured: result.value,
                        },
                        'structured output via provider native enforcement',
                    );
                    return {
                        response: JSON.stringify(result.value),
                        structured: result.value,
                    };
                }
                log.warn(
                    {
                        threadId,
                        errType: 'schema-validation',
                        errMessage: result.error.message,
                        attempts: result.attempts,
                        responsePreview: result.rawOutput.slice(0, 600),
                    },
                    'structuredLLM exhausted retries — falling back to team-agent path',
                );
                // fall through to the legacy path so we still produce
                // SOMETHING (often the team agent recovers on a retry)
            } catch (err) {
                const errMessage = err instanceof Error ? err.message : String(err);
                log.warn(
                    { threadId, errMessage },
                    'structuredLLM threw — falling back to team-agent path',
                );
            }
        }

        // Path 2 — team-agent path (legacy, also used when no schema).
        let reply = '';
        const callbacks = buildCallbacks((text) => {
            reply += text;
        }, options.personality);

        const result = await handler.invoke(message, threadId, callbacks, 'user');
        const response = result.reply ?? reply;

        if (options.responseSchema && response.trim()) {
            try {
                const raw = extractJson(response);
                const structured = options.responseSchema.parse(raw);
                log.info(
                    { threadId, responseLength: response.length, structured },
                    'team-agent path: structured output recovered via post-hoc parse',
                );
                return { response, structured };
            } catch (err) {
                const errMessage = err instanceof Error ? err.message : String(err);
                log.warn(
                    {
                        threadId,
                        errType: err instanceof SyntaxError ? 'json-parse'
                            : err instanceof Error && err.name === 'ZodError' ? 'schema-validation'
                            : 'unknown',
                        errMessage,
                        responseLength: response.length,
                        responsePreview: response.slice(0, 600),
                    },
                    'team-agent path: response is MALFORMED — returning raw text',
                );
            }
        }

        return { response };
    };
}

// Latched per-process so tight inner loops don't spam the log.
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

// Disclosed to the agent in the runtime block so it picks tools that will
// actually work in this context. Each line is one constraint. Kept terse —
// these land in every proactive turn's prompt, so verbosity is expensive.
const PROACTIVE_RUNTIME_HINTS: readonly string[] = [
    'context: proactive fire (heartbeat / cron / webhook) — no live user is on the other end of this turn.',
    'unavailable: send_poll (no poll surface), react (no specific user message to react to), eventQueue (one-shot turn — nothing to wait for).',
    'available: send_message (delivered to the configured channel), delegate_task / spawn_background_task, memory tools, MCP tools.',
    'output: keep replies tight — proactive turns are pushed to the user, not pulled. One coherent message, no clarifying questions.',
];

function buildCallbacks(onText: (t: string) => void, personality?: string) {
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
        signal: AbortSignal.timeout(300_000),
        channelName: 'proactive',
        channelCapabilities: [] as readonly string[],
        peer: { id: 'proactive', type: 'user' as const },
        runtimeHints: PROACTIVE_RUNTIME_HINTS,
        ...(personality ? { personality } : {}),
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
