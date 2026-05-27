import { scrubPii } from '@flopsy/shared';

/**
 * Normalise an unknown error for structured logging. PII-scrubs the message
 * and stack so secrets that leak into error strings (auth headers, tokens,
 * paths with usernames) don't reach the log sink.
 */
export function redactSecrets(err: unknown): { name?: string; message: string; stack?: string } {
    if (err instanceof Error) {
        return {
            name: err.name,
            message: scrubPii(err.message),
            stack: err.stack ? scrubPii(err.stack) : undefined,
        };
    }
    return { message: scrubPii(String(err)) };
}
