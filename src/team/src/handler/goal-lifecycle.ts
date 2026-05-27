import { createLogger } from '@flopsy/shared';
import type { BaseChatModel } from 'flopsygraph';
import { GoalManager, type GoalNotificationKind } from '../harness/goals/goal-manager';
import type { LearningStore } from '../harness';
import { redactSecrets } from './redact';

const log = createLogger('goal-lifecycle');

export type GoalContinuationCallback = (args: {
    threadId: string;
    channelName: string;
    peerId: string;
    prompt: string;
}) => void;

export type GoalNotificationCallback = (args: {
    threadId: string;
    channelName: string;
    peerId: string;
    kind: GoalNotificationKind;
    message: string;
}) => void;

export interface GoalLifecycleDeps {
    readonly extractorModel?: BaseChatModel;
    readonly store: LearningStore;
}

/**
 * Coordinator for the standing-goal Ralph-loop. Owns the `GoalManager`
 * instance (constructed lazily when an extractor model is configured) and
 * the gateway-supplied continuation + notification callbacks. Knows how to
 * dispatch a post-turn `maybeContinue` and route the resulting actions to
 * the gateway without leaking those callbacks into the rest of `TeamHandler`.
 */
export class GoalLifecycle {
    private readonly manager?: GoalManager;
    private continuationCb?: GoalContinuationCallback;
    private notificationCb?: GoalNotificationCallback;

    constructor(deps: GoalLifecycleDeps) {
        if (deps.extractorModel) {
            this.manager = new GoalManager({
                model: deps.extractorModel,
                store: deps.store,
            });
        }
    }

    getManager(): GoalManager | undefined {
        return this.manager;
    }

    setContinuationCallback(cb: GoalContinuationCallback): void {
        this.continuationCb = cb;
    }

    setNotificationCallback(cb: GoalNotificationCallback): void {
        this.notificationCb = cb;
    }

    /**
     * Fire-and-forget post-turn check: if a standing goal is active for the
     * thread, the judge decides DONE / CONTINUE / SKIPPED and the resulting
     * notification/continuation events fan out to the registered callbacks.
     * Errors are logged and swallowed — the user's turn must not fail because
     * the goal loop hiccuped.
     */
    dispatchPostTurn(args: {
        threadId: string;
        peerId: string;
        channelName: string;
        agentReply: string;
    }): void {
        if (!this.manager || !args.agentReply) return;
        const { threadId, peerId, channelName, agentReply } = args;
        const continuationCb = this.continuationCb;
        const notifyCb = this.notificationCb;
        void this.manager
            .maybeContinue({ threadId, agentReply })
            .then((result) => {
                if (!result) return;
                if (result.notificationMessage && result.notificationKind && notifyCb) {
                    notifyCb({
                        threadId,
                        channelName,
                        peerId,
                        kind: result.notificationKind,
                        message: result.notificationMessage,
                    });
                }
                if (result.shouldContinue && result.continuationPrompt && continuationCb) {
                    continuationCb({
                        threadId,
                        channelName,
                        peerId,
                        prompt: result.continuationPrompt,
                    });
                }
            })
            .catch((err) => {
                log.warn(
                    { threadId, peerId, err: redactSecrets(err) },
                    'goal manager threw (non-fatal, ignored)',
                );
            });
    }
}
