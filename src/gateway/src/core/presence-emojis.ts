/**
 * Single source of truth for lifecycle emojis used by the gateway.
 *
 * Anything that decorates a turn / task / queued-message reaction or
 * inline streaming label belongs here. Channels-specific overrides
 * live alongside (Telegram → ⏳, WhatsApp → 🤔, etc.) and merge over
 * the defaults.
 *
 * NOT in scope:
 *   - The agent's own `react` tool — the model picks emojis at runtime
 *     (see team/src/tools/react.ts).
 *   - Personality-specific reactions (e.g. savage: 🤨/💀/🎯) — those
 *     are part of the personality body in personalities.yaml and are
 *     directives to the model, not gateway-side decoration.
 *   - CLI status panel symbols (shared/src/status/format.ts) — those
 *     are user-visible CLI output, not channel reactions.
 */

export interface PresenceEmojis {
    // ── User-turn lifecycle (every normal chat message) ──────────────
    // Decorates the user's message while the agent runs the turn.
    // Suppressed when the agent calls the `react` tool itself — the
    // agent's chosen emoji wins so the lifecycle doesn't clobber it
    // on single-slot channels (Telegram).
    /** User's message reaction while a turn is in flight. */
    readonly turnRunning: string;
    /** Replaces `turnRunning` when the turn completed successfully. */
    readonly turnOk: string;
    /** Replaces `turnRunning` when the user aborted the turn (Ctrl+C, "stop"). */
    readonly turnAborted: string;
    /** Replaces `turnRunning` when the turn failed (timeout, provider error). */
    readonly turnError: string;

    /**
     * Reaction added to a user message that arrived mid-turn (queued,
     * will be processed after the current turn finishes). Cleared when
     * the queued message starts processing.
     */
    readonly turnQueued: string;

    // ── Background task lifecycle (spawn_background_task only) ───────
    // Decorates the user message that triggered a background spawn.
    // SEPARATE from the turn lifecycle: the foreground turn ends as
    // soon as the spawn returns "started", but the task keeps running.
    // task* emojis update later when the task itself completes.
    readonly taskRunning: string;
    readonly taskOk: string;
    readonly taskError: string;

    /** Default reaction acknowledging a direct mention before the agent
     *  has anything substantive to say. Used by channels with reactions
     *  but no typing indicator (or both). */
    readonly mentionAck: string;

    /**
     * Inline prefix for streaming "thinking" lines from reasoning-capable
     * models (qwen3.5-thinking, deepseek-r1, gpt-oss). Each thinking
     * line in the streamed preview is prefixed with this so users can
     * tell reasoning apart from the answer body.
     */
    readonly thinkingLinePrefix: string;
}

/**
 * The default presence emoji set. Channels can pass overrides through
 * channel config; unspecified keys fall back to these.
 */
export const DEFAULT_PRESENCE_EMOJIS: PresenceEmojis = {
    turnRunning:        '⏳',
    turnOk:             '✅',
    turnAborted:        '🛑',
    turnError:          '❌',
    turnQueued:         '⏳',
    taskRunning:        '⏳',
    taskOk:             '✅',
    taskError:          '❌',
    mentionAck:         '👀',
    thinkingLinePrefix: '💭',
};

/**
 * Merge channel overrides over the default set. Returns a fully-typed
 * `PresenceEmojis` so call sites don't need to handle undefined.
 */
export function resolvePresenceEmojis(
    overrides?: Partial<PresenceEmojis>,
): PresenceEmojis {
    if (!overrides) return DEFAULT_PRESENCE_EMOJIS;
    return { ...DEFAULT_PRESENCE_EMOJIS, ...overrides };
}

/**
 * Per-channel reaction policy. Lifecycle reactions (turn / task /
 * queued indicators) honour the SAME `direct` / `group` rules the
 * channel's `ackReaction` declares. Without this, a group chat
 * configured with `group: "never"` would still see ⏳/✅/❌ on every
 * agent turn — defeating the user's "don't react in groups" intent.
 *
 * Schema mirrors `ackReactionSchema` in shared/src/config/schema.ts;
 * if `ackReaction` is absent the policy resolves to "react everywhere
 * the channel supports reactions" (legacy behaviour).
 */
export interface ReactionPolicy {
    /** React on direct (DM) messages. */
    readonly direct: boolean;
    /** Group / channel policy: 'always', 'mentions' (only on @mention), 'never'. */
    readonly group: 'always' | 'mentions' | 'never';
}

export const DEFAULT_REACTION_POLICY: ReactionPolicy = {
    direct: true,
    group: 'mentions',
};

/**
 * Decide whether a reaction is allowed for a given peer type.
 *
 * `mentioned` should be true when the inbound message explicitly
 * tagged the bot. For lifecycle reactions on a CONTINUING turn (the
 * mention happened upstream and the worker has lost that signal),
 * pass `mentioned=true` so the same group/mentions setting that
 * gated the ack also gates the ⏳/✅/❌ pair.
 */
export function reactionAllowed(
    policy: ReactionPolicy,
    peerType: 'user' | 'group' | 'channel' | string,
    mentioned: boolean,
): boolean {
    const isGroup = peerType === 'group' || peerType === 'channel';
    if (isGroup) {
        if (policy.group === 'never') return false;
        if (policy.group === 'mentions') return mentioned;
        return true;
    }
    return policy.direct;
}
