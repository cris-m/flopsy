/**
 * Device-flow poller — one poll loop per pending authorization.
 * No persistence: a gateway restart mid-poll means the user re-runs `connect_service`.
 */

import { createLogger } from '@flopsy/shared';
import { googleDeviceFlow, type StoredCredential } from '@flopsy/cli';

const log = createLogger('device-poller');

export interface DevicePollerHandle {
    /** Cancel polling (e.g. user said "never mind"). */
    cancel(): void;
    readonly deviceCode: string;
}

export interface DevicePollOptions {
    /**
     * Per-service provider name (e.g. 'youtube', 'calendar'). Determines
     * which credential file the poll result is saved to ('<provider>.json').
     * Legacy 'google' still works but is no longer used in-chat.
     */
    readonly provider: string;
    readonly deviceCode: string;
    readonly intervalSeconds: number;
    readonly expiresAt: number;
    readonly scopes?: readonly string[];
    /** Called once on successful completion with the saved credential. */
    onSuccess(cred: StoredCredential): void | Promise<void>;
    /** Called on terminal failure (expired or denied). */
    onFailure(reason: 'expired' | 'denied' | 'cancelled' | 'error', detail?: string): void | Promise<void>;
}

export function startDevicePolling(opts: DevicePollOptions): DevicePollerHandle {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let intervalSec = Math.max(1, opts.intervalSeconds);

    const tick = async (): Promise<void> => {
        if (cancelled) return;
        if (Date.now() >= opts.expiresAt) {
            await safeCall(() => opts.onFailure('expired'));
            return;
        }
        if (inFlight) {
            // Reschedule rather than pile up on slow network.
            timer = setTimeout(() => void tick(), intervalSec * 1000);
            return;
        }
        inFlight = true;
        try {
            const result = await googleDeviceFlow.poll(
                opts.deviceCode,
                opts.scopes,
                opts.provider,
            );

            if (cancelled) return;

            if (result.status === 'success') {
                log.info(
                    { provider: opts.provider, email: result.credential.email },
                    'device-flow authorization succeeded',
                );
                await safeCall(() => opts.onSuccess(result.credential));
                return;
            }
            if (result.status === 'pending') {
                // RFC 8628 §3.5: on `slow_down` ADD 5s to the running interval (don't overwrite).
                if ((result as { slowDown?: boolean }).slowDown) {
                    intervalSec = intervalSec + 5;
                } else {
                    intervalSec = result.intervalSeconds;
                }
                timer = setTimeout(() => void tick(), intervalSec * 1000);
                return;
            }
            if (result.status === 'error') {
                log.warn(
                    { provider: opts.provider, detail: result.errorDetail },
                    'device flow OAuth error',
                );
                await safeCall(() => opts.onFailure('error', result.errorDetail));
                return;
            }
            log.info({ provider: opts.provider, status: result.status }, 'device flow terminal');
            await safeCall(() => opts.onFailure(result.status));
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'device-flow poll threw — retrying after interval',
            );
            timer = setTimeout(() => void tick(), intervalSec * 1000);
        } finally {
            inFlight = false;
        }
    };

    // RFC 8628: don't poll before the first interval elapses.
    timer = setTimeout(() => void tick(), intervalSec * 1000);

    return {
        deviceCode: opts.deviceCode,
        cancel(): void {
            cancelled = true;
            if (timer) clearTimeout(timer);
            timer = null;
            void safeCall(() => opts.onFailure('cancelled'));
        },
    };
}

/** Swallow callback errors so a buggy onSuccess/onFailure doesn't crash polling. */
async function safeCall(fn: () => unknown | Promise<unknown>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'device-poller callback threw',
        );
    }
}
