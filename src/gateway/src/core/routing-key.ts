/**
 * Derive a stable per-conversation id used as `threadId` in the agent
 * stack. Shape: `{channel}:{dm|group|channel}:{peerId}` with optional
 * `:user:{senderId}` suffix when `groupScope: 'per-participant'`.
 *
 * Group/channel keys default to per-chat (shared persona); per-participant
 * is opt-in. Routing keys must be STABLE — rotation is a separate concern.
 */

import type { Peer } from '@gateway/types';

export type GroupScope = 'per-chat' | 'per-participant';

export interface RoutingKeyInput {
    readonly channelName: string;
    readonly peer: Peer;
    /** Required for `groupScope: 'per-participant'`. Ignored for DMs. */
    readonly senderId?: string;
}

export interface BuildRoutingKeyOptions {
    readonly groupScope?: GroupScope;
}

export function buildRoutingKey(
    input: RoutingKeyInput,
    opts: BuildRoutingKeyOptions = {},
): string {
    const platform = sanitize(input.channelName);
    const peerType = peerKind(input.peer.type);
    const peerId = sanitize(input.peer.id);

    const base = `${platform}:${peerType}:${peerId}`;

    const wantsParticipant =
        (opts.groupScope ?? 'per-chat') === 'per-participant' &&
        input.peer.type !== 'user' &&
        !!input.senderId;

    if (!wantsParticipant) return base;
    return `${base}:user:${sanitize(input.senderId!)}`;
}

export function keyBelongsToChannel(key: string, channelName: string): boolean {
    const prefix = `${sanitize(channelName)}:`;
    return key.startsWith(prefix);
}

export function channelFromKey(key: string): string | undefined {
    const idx = key.indexOf(':');
    return idx > 0 ? key.slice(0, idx) : undefined;
}

/**
 * Best-effort reconstruction of a Peer from a routing key. Used by the
 * webhook auto-create path. Group/channel keys with embedded sender ids
 * reduce to the GROUP peer (the supergroup itself), matching delivery.
 */
export function peerFromKey(key: string): { id: string; type: 'user' | 'group' | 'channel' } | undefined {
    const parts = key.split(':');
    if (parts.length < 3) return undefined;
    const scope = parts[1];
    const id = parts.slice(2, parts[3] === 'user' ? 3 : parts.length).join(':');
    if (!id) return undefined;
    if (scope === 'dm')      return { id, type: 'user' };
    if (scope === 'group')   return { id, type: 'group' };
    if (scope === 'channel') return { id, type: 'channel' };
    return undefined;
}

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

// Reduce hostile characters to dashes so user-controlled peer ids can't
// inject extra colons. Don't lowercase — Discord snowflakes and WhatsApp
// JIDs are case-sensitive; collapsing would collide distinct peers.
function sanitize(s: string): string {
    if (!s) return '-';
    const cleaned = s.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/-+/g, '-');
    return cleaned.length > 0 ? cleaned : '-';
}
