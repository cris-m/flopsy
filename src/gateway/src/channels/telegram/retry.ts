/**
 * Retry runner for Telegram channel API calls.
 *
 * Adapted retry-async pattern (
 * `src/infra/retry-policy.ts:createRateLimitRetryRunner`). Honors
 * `retry_after` when present, falls back to exponential backoff
 * otherwise. `shouldRetry` decides which errors are retryable — pass
 * `isTelegramRateLimitError` to limit retries to 429s.
 */

import { setTimeout as sleep } from 'node:timers/promises';

export interface RetryOptions {
    attempts?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    /** 0–1. Multiplies the delay by `1 + rand(-jitter, +jitter)`. */
    jitter?: number;
    /** Return `true` to retry the call, `false` to give up. */
    shouldRetry: (err: unknown) => boolean;
    /** Per-error retry-after in ms (e.g. Telegram's `retry_after * 1000`). */
    retryAfterMs?: (err: unknown) => number | undefined;
    /** Side-channel notification for each retry decision. */
    onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
}

const DEFAULTS = {
    attempts: 3,
    minDelayMs: 400,
    // Telegram extends `retry_after` (sometimes to 60–120s+) when we retry
    // inside its cooldown window. Capping below the server's instruction
    // means we retry early, Telegram extends, we fail. 5 min is the ceiling
    // for a single sendMessage stall — anything longer is a server-side
    // outage and should not be silently waited on.
    maxDelayMs: 300_000,
    jitter: 0.1,
} as const;

function applyJitter(delayMs: number, jitter: number): number {
    if (jitter <= 0) return delayMs;
    const offset = (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(delayMs * (1 + offset)));
}

export async function retryTelegram<T>(
    fn: () => Promise<T>,
    opts: RetryOptions,
): Promise<T> {
    const attempts = opts.attempts ?? DEFAULTS.attempts;
    const minDelayMs = opts.minDelayMs ?? DEFAULTS.minDelayMs;
    const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
    const jitter = opts.jitter ?? DEFAULTS.jitter;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt >= attempts || !opts.shouldRetry(err)) break;
            const retryAfter = opts.retryAfterMs?.(err);
            const hasRetryAfter = retryAfter !== undefined;
            const base = hasRetryAfter
                ? Math.max(retryAfter, minDelayMs)
                : minDelayMs * 2 ** (attempt - 1);
            // When the server gave us a `retry_after`, honor it AS-IS — no
            // jitter, no cap below it. Retrying inside the server's stated
            // cooldown is what causes Telegram to extend the cooldown.
            // Only cap exponential-backoff (no retry_after) at maxDelayMs.
            const delay = hasRetryAfter
                ? Math.min(base, maxDelayMs)
                : Math.min(applyJitter(base, jitter), maxDelayMs);
            opts.onRetry?.({ attempt, delayMs: delay, err });
            if (delay > 0) await sleep(delay);
        }
    }
    throw lastErr ?? new Error('retry: max attempts exceeded');
}
