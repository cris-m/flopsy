// Cross-process lock so the gateway refresher, MCP children, and `flopsy auth refresh`
// don't clobber each other's refresh-token rotation on one <provider>.json. O_EXCL is
// atomic across processes; the stale-timeout frees a crashed holder's lock.

import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFlopsyHome } from '@flopsy/shared';

const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 100;
const LOCK_WAIT_TIMEOUT_MS = 20_000;

function authDir(): string {
    return join(resolveFlopsyHome(), 'auth');
}

function lockPath(provider: string): string {
    return join(authDir(), `${provider}.lock`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquire(provider: string): Promise<() => void> {
    const path = lockPath(provider);
    mkdirSync(authDir(), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

    for (;;) {
        try {
            const fd = openSync(path, 'wx');
            try {
                writeSync(fd, `${process.pid} ${Date.now()}\n`);
            } finally {
                closeSync(fd);
            }
            return () => {
                try {
                    rmSync(path);
                } catch {
                    /* already released or broken as stale */
                }
            };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
            try {
                const age = Date.now() - statSync(path).mtimeMs;
                if (age > LOCK_STALE_MS) {
                    rmSync(path);
                    continue;
                }
            } catch {
                continue;
            }
            if (Date.now() > deadline) {
                throw new Error(`Timed out acquiring credential lock for "${provider}"`);
            }
            await sleep(LOCK_POLL_MS);
        }
    }
}

export async function withCredentialLock<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const release = await acquire(provider);
    try {
        return await fn();
    } finally {
        release();
    }
}
