/**
 * Device-flow poller — runs ONE poll loop per pending authorization.
 *
 * Flow:
 *   1. connect_service tool calls googleDeviceFlow.start() → gets device_code,
 *      user_code, verificationUrl, interval, expires_in.
 *   2. Tool tells the user via send_message ("go to .../device, enter code XYZ").
 *   3. Tool calls `startPolling()` here — registers a setInterval that polls
 *      every `interval` seconds until success / expiry / denial.
 *   4. On success: invokes the supplied `onSuccess` callback which is
 *      responsible for notifying the user via the channel.
 *   5. On terminal failure: `onFailure` callback fires.
 *
 * The poller is INTENTIONALLY simple — no persistence. If the gateway
 * restarts mid-poll, the user has to re-run `connect_service`. Adding
 * persistence is straightforward (write {deviceCode, threadId, ...} to
 * state.db, resume on startup) but premature for v1.
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
    readonly provider: 'google';
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
    // Protect against concurrent polls (one in-flight at a time).
    let inFlight = false;
    // Honour Google's interval; bumped to 10s on slow_down.
    let intervalSec = Math.max(1, opts.intervalSeconds);

    const tick = async (): Promise<void> => {
        if (cancelled) return;
        if (Date.now() >= opts.expiresAt) {
            await safeCall(() => opts.onFailure('expired'));
            return;
        }
        if (inFlight) {
            // Previous poll still running — schedule another tick after the
            // current interval. Avoid pile-up on a slow network.
            timer = setTimeout(() => void tick(), intervalSec * 1000);
            return;
        }
        inFlight = true;
        try {
            const result =
                opts.provider === 'google'
                    ? await googleDeviceFlow.poll(opts.deviceCode, opts.scopes)
                    : { status: 'denied' as const };

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
                intervalSec = result.intervalSeconds;
                timer = setTimeout(() => void tick(), intervalSec * 1000);
                return;
            }
            // expired | denied | error — log the actionable detail for 'error'
            // so operators aren't staring at a useless "denied" in logs when
            // the real cause is invalid_grant/invalid_client/etc.
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

    // Kick off the first poll AFTER the initial interval — Google
    // explicitly says don't poll before the first interval elapses.
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
