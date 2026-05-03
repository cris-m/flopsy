import type { Interceptor } from 'flopsygraph';
import { createLogger } from '@flopsy/shared';

const log = createLogger('reflection-nudge');

const STORE_COUNT_KEY = 'flopsy:reflect:toolCount';
const STORE_FIRED_KEY = 'flopsy:reflect:fired';

interface NudgeOptions {
    threshold?: number;
}

export function reflectionNudge(options: NudgeOptions = {}): Interceptor {
    const threshold = Math.max(3, options.threshold ?? 5);

    return {
        name: 'reflection-nudge',
        afterToolCall(ctx) {
            // DCL meta-tools are catalog discovery, not substantive work.
            if (ctx.toolName.startsWith('__')) return;

            const count = ((ctx.store.get(STORE_COUNT_KEY) as number | undefined) ?? 0) + 1;
            ctx.store.set(STORE_COUNT_KEY, count);

            if (count !== threshold) return;
            if (ctx.store.get(STORE_FIRED_KEY) === true) return;
            ctx.store.set(STORE_FIRED_KEY, true);

            log.debug(
                { runId: ctx.runId, threadId: ctx.threadId, toolCount: count },
                'reflection nudge fired',
            );
            // afterToolCall can't mutate messages — beforeModelCall delivers the nudge.
        },

        beforeModelCall(ctx) {
            if (ctx.store.get(STORE_FIRED_KEY) !== true) return;
            const consumedKey = 'flopsy:reflect:consumed';
            if (ctx.store.get(consumedKey) === true) return;
            ctx.store.set(consumedKey, true);

            const count = (ctx.store.get(STORE_COUNT_KEY) as number | undefined) ?? threshold;
            const noteText =
                `[reflection — ${count} tool calls so far in this turn] ` +
                `If the work you just did is a procedure you (or another agent) would repeat — ` +
                `multi-step, non-obvious, or with specific pitfalls you discovered — call ` +
                `\`skill_manage(create, ...)\` BEFORE continuing so the next agent doesn't ` +
                `redo the discovery. If you used an existing skill and learned a new edge case, ` +
                `call \`skill_manage(append_lessons, ...)\` instead. Skip this if the work ` +
                `was straightforward or one-off.`;

            return {
                messages: [
                    ...ctx.messages,
                    { role: 'system', content: noteText },
                ],
            };
        },
    };
}
