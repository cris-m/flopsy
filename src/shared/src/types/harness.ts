/**
 * UserFeedback — the only learning-system type still in use.
 *
 * Returned by `detectDirective()` when the user's message starts with a
 * directive pattern ("always X", "never Y", "from now on Z"). The
 * harness interceptor inspects the `explicit.type === 'correction'`
 * branch and persists the rule via `learningStore.insertDirective()`.
 *
 * The wider Strategy/Lesson/Skill/Signal taxonomy this file used to host
 * was the old learning architecture; that whole stack was replaced by
 * the lean profile/notes/directives schema in `learning-store.ts`.
 */
export interface UserFeedback {
    explicit?: {
        type: 'positive' | 'negative' | 'correction';
        text: string;
    };

    followUp?: boolean;
    shared?: boolean;
    ignored?: boolean;
    rating?: number;
    message?: string;
}
