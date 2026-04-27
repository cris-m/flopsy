import { createLogger } from '@flopsy/shared';
import type { BaseChatModel } from 'flopsygraph';
import type { LearningStore, MessageRow } from '../storage';

const log = createLogger('away-reviewer');

// Look back at most this many messages from the previous session.
const RECAP_MESSAGE_WINDOW = 30;
// Hard timeout on the recap LLM call.
const RECAP_TIMEOUT_MS = 60_000;

const RECAP_SYSTEM =
    'You are writing a short re-engagement note for a user who is resuming a conversation after being away. ' +
    'Write exactly 1-3 sentences. Start with the high-level task (what they were building or debugging — not implementation details). ' +
    'End with the concrete next step. ' +
    'Omit greetings, status reports, and commit recaps. Output plain text only.';

export interface AwayReviewerConfig {
    readonly model: BaseChatModel;
    readonly store: LearningStore;
}

/**
 * Generates a short "where we left off" summary when a user's session
 * is rotated due to idle timeout. Called fire-and-forget from the handler
 * after SessionResolver returns `closeReason: 'idle'`.
 *
 * The result is injected as a system-role turn into the new session so
 * the model immediately has context without re-reading the old thread.
 */
export class AwayReviewer {
    constructor(private readonly config: AwayReviewerConfig) {}

    /**
     * Generate a re-engagement recap for the previous session.
     * Returns null if there isn't enough context or the LLM fails.
     * Never throws — safe to call fire-and-forget.
     */
    async generateRecap(previousThreadId: string): Promise<string | null> {
        const messages = this.config.store.getThreadMessages(
            previousThreadId,
            RECAP_MESSAGE_WINDOW,
        );

        // Need at least a few turns to have a recap worth generating.
        if (messages.length < 4) {
            log.debug({ previousThreadId, count: messages.length }, 'too few messages for recap');
            return null;
        }

        const transcript = formatTranscript(messages);

        try {
            const signal = AbortSignal.timeout(RECAP_TIMEOUT_MS);
            const response = await this.config.model.invoke(
                [
                    { role: 'system', content: RECAP_SYSTEM },
                    {
                        role: 'user',
                        content: `Conversation transcript:\n\n${transcript}\n\nWrite the re-engagement note.`,
                    },
                ],
                { signal },
            );

            const text =
                typeof response.content === 'string'
                    ? response.content.trim()
                    : response.content
                          .filter((b) => b.type === 'text')
                          .map((b) => (b as { text: string }).text)
                          .join('')
                          .trim();

            if (!text) return null;

            log.info({ previousThreadId, chars: text.length }, 'away recap generated');
            return text;
        } catch (err) {
            log.warn({ err, previousThreadId }, 'away recap failed');
            return null;
        }
    }
}

function formatTranscript(messages: MessageRow[]): string {
    return messages
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 400)}`)
        .join('\n');
}
