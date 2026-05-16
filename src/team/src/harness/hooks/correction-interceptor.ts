/**
 * Captures user corrections (e.g. "actually it's...", "no, that's wrong") and
 * persists them as notes in the `memory` namespace so future search_memory finds them.
 */

import { createLogger } from '@flopsy/shared';
import { BaseInterceptor } from 'flopsygraph';
import type { InterceptorModelContext, InterceptorToolContext } from 'flopsygraph';
import type { BaseStore } from 'flopsygraph';

const log = createLogger('correction-interceptor');

const CORRECTION_PATTERNS = [
    /\bno[,.\s]+that'?s?\s+(not\s+)?(right|correct|what\s+I\s+(meant|said|asked|wanted))\b/i,
    /\byou\s+(misunderstood|misread|misheard|got\s+it\s+wrong|missed)\b/i,
    /\bactually[,.\s]+(it'?s?|the|that|what\s+I\s+)\b/i,
    /\bthat'?s?\s+(incorrect|wrong|not\s+right|not\s+accurate|false)\b/i,
    /\b(no|nah)[,.\s]+(I\s+(meant|said|asked|wanted|need|was\s+talking\s+about))\b/i,
    /\b(please|pls)\s+correct\b/i,
];

/** Minimum length of the correction body to qualify as meaningful. */
const MIN_CORRECTION_BODY_LENGTH = 20;

export class CorrectionInterceptor extends BaseInterceptor {
    readonly name = 'correction-feedback';
    readonly description =
        'Captures user corrections → persists to memory for future retrieval.';
    readonly priority = 80; // Runs BEFORE messageQueue so corrections survive interrupt.

    private lastAssistantReply: string | null = null;

    async afterToolCall(
        ctx: InterceptorToolContext,
        _output: string,
        _isError: boolean,
    ): Promise<void> {
        // Stash placeholder; the actual assistant text is captured in beforeModelCall.
        if (ctx.toolName === 'send_message' || ctx.toolName === 'onReply') {
            /* see beforeModelCall */
        }
    }

    beforeModelCall(
        ctx: InterceptorModelContext,
    ): void {
        const messages = ctx.messages;

        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]!.role === 'assistant') {
                const content = messages[i]!.content;
                this.lastAssistantReply =
                    typeof content === 'string' ? content : JSON.stringify(content);
                break;
            }
        }

        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]!.role !== 'user') continue;
            const content = messages[i]!.content;
            const userText = typeof content === 'string' ? content : '';

            if (this.detectCorrection(userText)) {
                // Fire-and-forget; never blocks the model call.
                void this.persistCorrection(userText).catch((err) => {
                    log.debug('correction persist failed (non-fatal) %s', err instanceof Error ? err.message : String(err));
                });
                break;
            }
        }
    }

    private detectCorrection(text: string): boolean {
        if (text.length < MIN_CORRECTION_BODY_LENGTH) return false;
        return CORRECTION_PATTERNS.some((re) => re.test(text));
    }

    private async persistCorrection(userCorrectionText: string): Promise<void> {
        // configurable isn't available in beforeModelCall, so use the module-level setter.
        const store = getCorrectionStore();
        if (!store) return;

        const date = new Date().toISOString().slice(0, 10);
        const prevSnippet = this.lastAssistantReply
            ? this.lastAssistantReply.slice(0, 300).trim()
            : '(unknown)';

        const note = [
            `⚠️ User correction on ${date}.`,
            ``,
            `What the user said to correct you:`,
            `"${userCorrectionText.slice(0, 500)}"`,
            ``,
            `What you said before the correction (for context):`,
            `"${prevSnippet}"`,
            ``,
            `When this note appears in future search results, apply the correction.`,
            `Do not repeat the mistake.`,
        ].join('\n');

        try {
            await store.add({
                namespace: 'memory',
                content: note,
                metadata: {
                    type: 'correction',
                    date,
                    source: 'correction-interceptor',
                },
            });
            log.info({ chars: note.length }, 'correction persisted to memory');
        } catch (err) {
            log.debug({ err }, 'correction persist write failed');
        }
    }
}

// Module-level store setter (interceptor hooks don't receive configurable).

let _correctionStore: BaseStore | null = null;

export function setCorrectionStore(store: BaseStore | null): void {
    _correctionStore = store;
}

export function getCorrectionStore(): BaseStore | null {
    return _correctionStore;
}