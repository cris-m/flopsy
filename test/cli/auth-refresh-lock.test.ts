import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCredentialLock } from '../../src/cli/src/auth/refresh-lock';
import { isInvalidGrant } from '../../src/cli/src/auth/refresh';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let home: string;
let prevHome: string | undefined;

beforeAll(() => {
    prevHome = process.env.FLOPSY_HOME;
    home = mkdtempSync(join(tmpdir(), 'flopsy-auth-'));
    process.env.FLOPSY_HOME = home;
    mkdirSync(join(home, 'auth'), { recursive: true });
});

afterAll(() => {
    if (prevHome === undefined) delete process.env.FLOPSY_HOME;
    else process.env.FLOPSY_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
});

describe('withCredentialLock', () => {
    it('serializes concurrent holders of the same provider', async () => {
        const order: string[] = [];
        const a = withCredentialLock('google', async () => {
            order.push('a-start');
            await sleep(40);
            order.push('a-end');
        });
        const b = withCredentialLock('google', async () => {
            order.push('b-start');
            order.push('b-end');
        });
        await Promise.all([a, b]);
        expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    });

    it('releases the lock so a later call can acquire it', async () => {
        let ran = false;
        await withCredentialLock('google', async () => {});
        await withCredentialLock('google', async () => {
            ran = true;
        });
        expect(ran).toBe(true);
    });

    it('breaks a stale lock left by a crashed holder', async () => {
        const lockFile = join(home, 'auth', 'spotify.lock');
        writeFileSync(lockFile, 'dead-holder');
        const past = (Date.now() - 60_000) / 1000;
        utimesSync(lockFile, past, past);

        let ran = false;
        await withCredentialLock('spotify', async () => {
            ran = true;
        });
        expect(ran).toBe(true);
    });

    it('returns the wrapped function result', async () => {
        const result = await withCredentialLock('twitter', async () => 42);
        expect(result).toBe(42);
    });
});

describe('isInvalidGrant', () => {
    it('detects revoked / invalid refresh tokens', () => {
        expect(isInvalidGrant(new Error('invalid_grant'))).toBe(true);
        expect(isInvalidGrant(new Error('Token has been expired or revoked.'))).toBe(true);
        expect(isInvalidGrant(new Error('unauthorized_client'))).toBe(true);
        expect(isInvalidGrant('refresh token is invalid')).toBe(true);
    });

    it('does not misclassify transient/network errors', () => {
        expect(isInvalidGrant(new Error('ETIMEDOUT connecting to oauth2.googleapis.com'))).toBe(false);
        expect(isInvalidGrant(new Error('500 Internal Server Error'))).toBe(false);
        expect(isInvalidGrant(new Error('socket hang up'))).toBe(false);
    });
});
