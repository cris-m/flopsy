/**
 * PairingStore — code minting, TTL, cap, approve/revoke roundtrip.
 *
 * Uses an in-memory better-sqlite3 DB to avoid touching .flopsy/state.db.
 * Fake timers drive expiry without real waits.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PAIRING_CODE_ALPHABET,
    PAIRING_CODE_LENGTH,
    PAIRING_MAX_PENDING_PER_CHANNEL,
    PAIRING_PENDING_TTL_MS,
    PairingStore,
} from '@flopsy/team';

function freshStore(): { store: PairingStore; close: () => void } {
    const db = new Database(':memory:');
    const store = new PairingStore(db);
    return { store, close: () => db.close() };
}

describe('PairingStore', () => {
    describe('requestCode', () => {
        it('mints an 8-character code from the Crockford-like alphabet', () => {
            const { store, close } = freshStore();
            try {
                const result = store.requestCode('telegram', '5257796557');
                expect(result).not.toBeNull();
                expect(result!.code).toHaveLength(PAIRING_CODE_LENGTH);
                expect(result!.isNew).toBe(true);
                for (const ch of result!.code) {
                    expect(PAIRING_CODE_ALPHABET).toContain(ch);
                }
            } finally {
                close();
            }
        });

        it('reuses the same code for the same sender within TTL (idempotent)', () => {
            const { store, close } = freshStore();
            try {
                const first = store.requestCode('telegram', 'abc', 'Alice');
                const second = store.requestCode('telegram', 'abc', 'Alice');
                expect(second).not.toBeNull();
                expect(second!.code).toBe(first!.code);
                expect(second!.isNew).toBe(false);
            } finally {
                close();
            }
        });

        it('refuses new codes when the channel is at the pending cap', () => {
            const { store, close } = freshStore();
            try {
                for (let i = 0; i < PAIRING_MAX_PENDING_PER_CHANNEL; i++) {
                    const r = store.requestCode('telegram', `sender_${i}`);
                    expect(r).not.toBeNull();
                }
                const overflow = store.requestCode('telegram', 'sender_overflow');
                expect(overflow).toBeNull();
            } finally {
                close();
            }
        });

        it('caps are per-channel — discord pending does not block telegram', () => {
            const { store, close } = freshStore();
            try {
                for (let i = 0; i < PAIRING_MAX_PENDING_PER_CHANNEL; i++) {
                    store.requestCode('discord', `d_${i}`);
                }
                const tg = store.requestCode('telegram', 'tg_user');
                expect(tg).not.toBeNull();
            } finally {
                close();
            }
        });

        it('after TTL expires, a new code is minted (not the stale one)', () => {
            vi.useFakeTimers();
            const { store, close } = freshStore();
            try {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                const first = store.requestCode('telegram', 'abc');
                vi.setSystemTime(Date.now() + PAIRING_PENDING_TTL_MS + 1_000);
                const second = store.requestCode('telegram', 'abc');
                expect(second).not.toBeNull();
                expect(second!.isNew).toBe(true);
                // Could collide by chance, but vanishingly unlikely (1 / 32^8).
                expect(second!.code).not.toBe(first!.code);
            } finally {
                close();
                vi.useRealTimers();
            }
        });

        it('expired pending rows do not count toward the cap', () => {
            vi.useFakeTimers();
            const { store, close } = freshStore();
            try {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                for (let i = 0; i < PAIRING_MAX_PENDING_PER_CHANNEL; i++) {
                    store.requestCode('telegram', `old_${i}`);
                }
                vi.setSystemTime(Date.now() + PAIRING_PENDING_TTL_MS + 1_000);
                const fresh = store.requestCode('telegram', 'new_sender');
                expect(fresh).not.toBeNull();
            } finally {
                close();
                vi.useRealTimers();
            }
        });
    });

    describe('approveByCode', () => {
        it('moves the sender from pending to approved', () => {
            const { store, close } = freshStore();
            try {
                const minted = store.requestCode('telegram', 'sender_a', 'Alice');
                expect(minted).not.toBeNull();

                const approved = store.approveByCode('telegram', minted!.code);
                expect(approved).toEqual({ senderId: 'sender_a', senderName: 'Alice' });

                expect(store.isApproved('telegram', 'sender_a')).toBe(true);
                expect(store.listPending('telegram')).toHaveLength(0);
                expect(store.listApproved('telegram')).toHaveLength(1);
            } finally {
                close();
            }
        });

        it('accepts lowercase codes (normalizes to uppercase)', () => {
            const { store, close } = freshStore();
            try {
                const minted = store.requestCode('telegram', 'sender_a');
                const approved = store.approveByCode('telegram', minted!.code.toLowerCase());
                expect(approved).not.toBeNull();
            } finally {
                close();
            }
        });

        it('returns null for an unknown code', () => {
            const { store, close } = freshStore();
            try {
                expect(store.approveByCode('telegram', 'NOSUCH00')).toBeNull();
            } finally {
                close();
            }
        });

        it('returns null and sweeps the row for an expired code', () => {
            vi.useFakeTimers();
            const { store, close } = freshStore();
            try {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                const minted = store.requestCode('telegram', 'sender_a');
                vi.setSystemTime(Date.now() + PAIRING_PENDING_TTL_MS + 1_000);

                expect(store.approveByCode('telegram', minted!.code)).toBeNull();
                expect(store.isApproved('telegram', 'sender_a')).toBe(false);
            } finally {
                close();
                vi.useRealTimers();
            }
        });
    });

    describe('revoke + isApproved', () => {
        it('revoke returns true on a real removal, false on a no-op', () => {
            const { store, close } = freshStore();
            try {
                store.approveBySenderId('telegram', 'sender_a', 'Alice');
                expect(store.revoke('telegram', 'sender_a')).toBe(true);
                expect(store.revoke('telegram', 'sender_a')).toBe(false);
                expect(store.isApproved('telegram', 'sender_a')).toBe(false);
            } finally {
                close();
            }
        });

        it('isApproved is scoped per channel', () => {
            const { store, close } = freshStore();
            try {
                store.approveBySenderId('telegram', 'shared_id', 'Bob');
                expect(store.isApproved('telegram', 'shared_id')).toBe(true);
                expect(store.isApproved('discord', 'shared_id')).toBe(false);
            } finally {
                close();
            }
        });
    });

    describe('clearExpired vs clearAllPending', () => {
        it('clearExpired drops only TTL-expired rows', () => {
            // Insert 'old' at t=0, 'fresh' at t=halfTTL (so requestCode's internal
            // sweep doesn't touch 'old' yet — both rows still inside the window),
            // then advance to t=TTL+small so only 'old' is expired.
            vi.useFakeTimers();
            const { store, close } = freshStore();
            try {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                store.requestCode('telegram', 'old');
                vi.setSystemTime(Date.now() + PAIRING_PENDING_TTL_MS / 2);
                store.requestCode('telegram', 'fresh');
                vi.setSystemTime(Date.now() + PAIRING_PENDING_TTL_MS / 2 + 1_000);

                const removed = store.clearExpired();
                expect(removed).toBe(1);
                const remaining = store.listPending('telegram');
                expect(remaining.map((p) => p.senderId)).toEqual(['fresh']);
            } finally {
                close();
                vi.useRealTimers();
            }
        });

        it('clearAllPending drops every row regardless of age', () => {
            const { store, close } = freshStore();
            try {
                store.requestCode('telegram', 'a');
                store.requestCode('telegram', 'b');
                store.requestCode('discord', 'c');

                expect(store.clearAllPending('telegram')).toBe(2);
                expect(store.listPending('telegram')).toHaveLength(0);
                expect(store.listPending('discord')).toHaveLength(1);

                expect(store.clearAllPending()).toBe(1);
                expect(store.listPending()).toHaveLength(0);
            } finally {
                close();
            }
        });
    });

    describe('listPending / listApproved ordering', () => {
        it('listPending returns newest first', () => {
            vi.useFakeTimers();
            const { store, close } = freshStore();
            try {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                store.requestCode('telegram', 'first');
                vi.setSystemTime(Date.now() + 60_000);
                store.requestCode('telegram', 'second');

                const list = store.listPending('telegram');
                expect(list.map((p) => p.senderId)).toEqual(['second', 'first']);
            } finally {
                close();
                vi.useRealTimers();
            }
        });
    });
});
