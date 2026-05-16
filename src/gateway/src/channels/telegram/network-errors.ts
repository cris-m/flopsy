/**
 * Telegram error classification.
 *
 * Grammy wraps Telegram API errors in `GrammyError`. A 429 (rate limit)
 * comes back with a `parameters.retry_after` field in seconds. The
 * field can sit in three different places depending on how the error
 * was wrapped on the way up. Standard error-mapping pattern from
 * `extensions/telegram/src/network-errors.ts` +
 * `infra/retry-policy.ts:getChannelApiRetryAfterMs`.
 */

type RetryAfterContainer = { parameters?: { retry_after?: number } };

function readRetryAfter(err: unknown): number | undefined {
    if (!err || typeof err !== 'object') return undefined;
    const top = (err as RetryAfterContainer).parameters?.retry_after;
    if (typeof top === 'number' && Number.isFinite(top)) return top;
    const response = (err as { response?: RetryAfterContainer }).response?.parameters?.retry_after;
    if (typeof response === 'number' && Number.isFinite(response)) return response;
    const inner = (err as { error?: RetryAfterContainer }).error?.parameters?.retry_after;
    if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
    return undefined;
}

/**
 * `true` when the error is a Telegram 429 (rate-limited). Sender should
 * back off for `getTelegramRetryAfterMs(err)` and retry the same call —
 * NOT fall through to a different parse_mode (it's not a format error).
 */
export function isTelegramRateLimitError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    if ((err as { error_code?: number }).error_code === 429) return true;
    return readRetryAfter(err) !== undefined;
}

/**
 * Retry-after in milliseconds, extracted from any of the three shapes
 * Grammy uses. Returns `undefined` when the error is not a 429 or has
 * no retry_after parameter.
 */
export function getTelegramRetryAfterMs(err: unknown): number | undefined {
    const seconds = readRetryAfter(err);
    return seconds === undefined ? undefined : seconds * 1000;
}
