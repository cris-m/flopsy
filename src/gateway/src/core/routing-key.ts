/**
 * routing-key — derive a stable per-conversation id from a message.
 *
 * Used as `threadId` throughout the agent stack. Replaces the old
 * `threadId = channel.name` pattern that collapsed every user on a platform
 * into one shared conversation.
 *
 * Shape (chosen to match Hermes's `agent:main:{platform}:{chat_type}:{chat_id}`
 * but without the `agent:main:` prefix — we're single-entry-agent-per-key
 * today; prefix can be added later without breaking compatibility):
 *
 *   {channel}:dm:{peerId}
 *   {channel}:group:{peerId}
 *   {channel}:channel:{peerId}
 *
 * Why NOT include senderId in group/channel keys by default:
 *   A group conversation is shared context — everyone in the Telegram group
 *   or Discord channel should see one coherent assistant persona, not N
 *   private sessions. If per-user-in-group isolation is ever needed, pass
 *   `scope: 'per-participant'`; the message prefixing pattern (`[alice]: …`)
 *   is the normal way to disambiguate speakers inside a shared session.
 *
 * Why NOT include day / timestamp:
 *   The routing key must be STABLE so ongoing conversations route back to
 *   the same checkpoint. Rotation (daily cutover, idle timeout) is a
 *   separate concern handled by an optional session-id suffix later.
 */

import type { Peer } from '@gateway/types';

export type GroupScope = 'per-chat' | 'per-participant';

export interface RoutingKeyInput {
    readonly channelName: string;
    readonly peer: Peer;
    /**
     * For groups/channels, the sender is needed if the caller wants per-user
     * scoping (`scope: 'per-participant'`). Ignored for DMs.
     */
    readonly senderId?: string;
}

export interface BuildRoutingKeyOptions {
    /** Default: 'per-chat'. */
    readonly groupScope?: GroupScope;
}

/**
 * Build the routing key for an inbound message.
 *
 * @example
 *   buildRoutingKey({ channelName: 'telegram', peer: { id: '847', type: 'user' } })
 *   // → 'telegram:dm:847'
 *
 *   buildRoutingKey({ channelName: 'discord', peer: { id: '8123', type: 'group' } })
 *   // → 'discord:group:8123'
 *
 *   buildRoutingKey(
 *     { channelName: 'whatsapp', peer: { id: 'abc', type: 'group' }, senderId: 'xyz' },
 *     { groupScope: 'per-participant' },
 *   )
 *   // → 'whatsapp:group:abc:user:xyz'
 */
export function buildRoutingKey(
    input: RoutingKeyInput,
    opts: BuildRoutingKeyOptions = {},
): string {
    const platform = sanitize(input.channelName);
    const peerType = peerKind(input.peer.type);
    const peerId = sanitize(input.peer.id);

    const base = `${platform}:${peerType}:${peerId}`;

    // Per-user scoping only meaningful for shared spaces.
    const wantsParticipant =
        (opts.groupScope ?? 'per-chat') === 'per-participant' &&
        input.peer.type !== 'user' &&
        !!input.senderId;

    if (!wantsParticipant) return base;
    return `${base}:user:${sanitize(input.senderId!)}`;
}

/**
 * Check whether a routing key belongs to a given channel. Cheap prefix
 * match. Used by the router to stop all workers for a channel on shutdown.
 */
export function keyBelongsToChannel(key: string, channelName: string): boolean {
    const prefix = `${sanitize(channelName)}:`;
    return key.startsWith(prefix);
}

/**
 * Extract the channel name from a routing key.
 * Returns undefined for malformed keys.
 */
export function channelFromKey(key: string): string | undefined {
    const idx = key.indexOf(':');
    return idx > 0 ? key.slice(0, idx) : undefined;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function peerKind(t: Peer['type']): 'dm' | 'group' | 'channel' {
    switch (t) {
        case 'user':
            return 'dm';
        case 'group':
            return 'group';
        case 'channel':
            return 'channel';
    }
}

/**
 * Reduce any hostile characters in user-supplied identifiers to dashes,
 * then collapse runs. Prevents a user-controlled peer id from producing a
 * key with extra colons that confuse parsing or match other buckets.
 *
 * Kept lenient: we don't lowercase, because some platform IDs are
 * case-sensitive (Discord snowflakes are numeric, WhatsApp JIDs mix case
 * in server portion). Lowercasing would collide distinct peers.
 */
function sanitize(s: string): string {
    if (!s) return '-';
    const cleaned = s.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/-+/g, '-');
    return cleaned.length > 0 ? cleaned : '-';
}
