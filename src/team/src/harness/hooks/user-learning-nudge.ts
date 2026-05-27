import type { Interceptor } from 'flopsygraph';
import { createLogger } from '@flopsy/shared';

const log = createLogger('user-learning-nudge');

const STORE_COUNT_KEY = 'flopsy:userlearn:calls';
const STORE_FIRED_KEY = 'flopsy:userlearn:fired';

interface UserLearningNudgeOptions {
    fireOnCall?: number;
}

const NUDGE_TEXT = [
    '[getting to know the user]',
    'If the USER.md profile shown in your context is empty or still just the template',
    'scaffold, you have not met this person yet. As you help them, watch for stable facts',
    'worth keeping across sessions — what to call them, their role, timezone, languages,',
    'and communication preferences — and persist them with',
    '`memory({action: "add", target: "user", content: "..."})`.',
    'Learn from the conversation; do NOT interrogate or run a questionnaire. If the profile',
    'is already populated, or nothing personal has surfaced yet, ignore this and carry on.',
].join(' ');

export function userLearningNudge(options: UserLearningNudgeOptions = {}): Interceptor {
    const fireOn = Math.max(1, options.fireOnCall ?? 2);

    return {
        name: 'user-learning-nudge',

        beforeModelCall(ctx) {
            if (ctx.store.get(STORE_FIRED_KEY) === true) return;

            const calls = ((ctx.store.get(STORE_COUNT_KEY) as number | undefined) ?? 0) + 1;
            ctx.store.set(STORE_COUNT_KEY, calls);
            if (calls < fireOn) return;

            const hasUserMessage = ctx.messages.some((m) => m.role === 'user');
            if (!hasUserMessage) return;

            ctx.store.set(STORE_FIRED_KEY, true);
            log.debug(
                { runId: ctx.runId, threadId: ctx.threadId, calls },
                'user-learning nudge fired',
            );

            return {
                messages: [...ctx.messages, { role: 'system', content: NUDGE_TEXT }],
            };
        },
    };
}
