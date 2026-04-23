import { describe, it, expect } from 'vitest';
import type { Peer } from '@gateway/types';
import {
    buildRoutingKey,
    channelFromKey,
    keyBelongsToChannel,
} from '@gateway/core/routing-key';

const user = (id: string): Peer => ({ id, type: 'user' });
const group = (id: string): Peer => ({ id, type: 'group' });
const channel = (id: string): Peer => ({ id, type: 'channel' });

describe('buildRoutingKey / DM', () => {
    it('encodes platform + dm + peerId', () => {
        expect(buildRoutingKey({ channelName: 'telegram', peer: user('847') })).toBe(
            'telegram:dm:847',
        );
    });

    it('separates two different users on the same platform', () => {
        const alice = buildRoutingKey({ channelName: 'telegram', peer: user('111') });
        const bob = buildRoutingKey({ channelName: 'telegram', peer: user('222') });
        expect(alice).not.toBe(bob);
    });

    it('separates the same user on two platforms (correct — distinct contexts)', () => {
        const tele = buildRoutingKey({ channelName: 'telegram', peer: user('847') });
        const disc = buildRoutingKey({ channelName: 'discord', peer: user('847') });
        expect(tele).not.toBe(disc);
    });

    it('ignores senderId in DM even if provided (the sender IS the peer)', () => {
        const withSender = buildRoutingKey({
            channelName: 'telegram',
            peer: user('847'),
            senderId: 'anything',
        });
        const withoutSender = buildRoutingKey({
            channelName: 'telegram',
            peer: user('847'),
        });
        expect(withSender).toBe(withoutSender);
    });
});

describe('buildRoutingKey / groups', () => {
    it('encodes platform + group + peerId', () => {
        expect(buildRoutingKey({ channelName: 'discord', peer: group('8123') })).toBe(
            'discord:group:8123',
        );
    });

    it('per-chat default: a group is ONE thread regardless of speaker', () => {
        const aliceSpeaking = buildRoutingKey({
            channelName: 'discord',
            peer: group('8123'),
            senderId: 'alice',
        });
        const bobSpeaking = buildRoutingKey({
            channelName: 'discord',
            peer: group('8123'),
            senderId: 'bob',
        });
        expect(aliceSpeaking).toBe(bobSpeaking);
    });

    it('per-participant: each user has their own thread in a group', () => {
        const aliceKey = buildRoutingKey(
            { channelName: 'discord', peer: group('8123'), senderId: 'alice' },
            { groupScope: 'per-participant' },
        );
        const bobKey = buildRoutingKey(
            { channelName: 'discord', peer: group('8123'), senderId: 'bob' },
            { groupScope: 'per-participant' },
        );
        expect(aliceKey).toBe('discord:group:8123:user:alice');
        expect(bobKey).toBe('discord:group:8123:user:bob');
        expect(aliceKey).not.toBe(bobKey);
    });

    it('per-participant without senderId falls back to per-chat', () => {
        const key = buildRoutingKey(
            { channelName: 'discord', peer: group('8123') },
            { groupScope: 'per-participant' },
        );
        expect(key).toBe('discord:group:8123');
    });
});

describe('buildRoutingKey / channels', () => {
    it('encodes channel peer type', () => {
        expect(buildRoutingKey({ channelName: 'discord', peer: channel('456') })).toBe(
            'discord:channel:456',
        );
    });
});

describe('buildRoutingKey / sanitization', () => {
    it('colons in peer id are stripped to dashes (prevents key-injection)', () => {
        const key = buildRoutingKey({
            channelName: 'telegram',
            peer: user('847:evil:extra'),
        });
        expect(key).toBe('telegram:dm:847-evil-extra');
    });

    it('spaces and other hostile chars are dashed', () => {
        const key = buildRoutingKey({
            channelName: 'telegram',
            peer: user('847 user!'),
        });
        expect(key).toBe('telegram:dm:847-user-');
    });

    it('empty peer id is replaced with dash sentinel', () => {
        const key = buildRoutingKey({
            channelName: 'telegram',
            peer: user(''),
        });
        expect(key).toBe('telegram:dm:-');
    });

    it('preserves case (platform IDs like Discord snowflakes are case-sensitive)', () => {
        const key = buildRoutingKey({
            channelName: 'whatsapp',
            peer: user('1234ABCD@s.whatsapp.net'),
        });
        expect(key).toMatch(/^whatsapp:dm:/);
        expect(key).toContain('ABCD');
    });
});

describe('channelFromKey', () => {
    it('extracts the platform prefix', () => {
        expect(channelFromKey('telegram:dm:847')).toBe('telegram');
        expect(channelFromKey('discord:group:8123')).toBe('discord');
    });

    it('returns undefined for malformed keys', () => {
        expect(channelFromKey('notarealkey')).toBeUndefined();
        expect(channelFromKey('')).toBeUndefined();
    });
});

describe('keyBelongsToChannel', () => {
    it('true for exact channel match', () => {
        expect(keyBelongsToChannel('telegram:dm:847', 'telegram')).toBe(true);
    });

    it('false for different channel', () => {
        expect(keyBelongsToChannel('telegram:dm:847', 'discord')).toBe(false);
    });

    it('false for channel-name prefix that is not a full match', () => {
        // 'tele' is a prefix of 'telegram' but belongsToChannel('tele') should be false.
        expect(keyBelongsToChannel('telegram:dm:847', 'tele')).toBe(false);
    });

    it('handles sanitised channel names consistently', () => {
        // Same sanitise rule as buildRoutingKey — colon-hostile input folded.
        expect(keyBelongsToChannel('we.chat:dm:x', 'we.chat')).toBe(true);
    });
});
