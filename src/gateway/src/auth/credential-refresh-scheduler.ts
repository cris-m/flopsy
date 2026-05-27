import {
    isInvalidGrant,
    listCredentialProviders,
    loadCredential,
    refreshCredentialNow,
} from '@flopsy/cli';
import { createLogger } from '@flopsy/shared';

const log = createLogger('credential-refresh');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Wider than getValidCredential's lazy 5-min buffer so the proactive pass renews before any request path does.
const REFRESH_MARGIN_MS = 15 * 60 * 1000;

export interface CredentialRefreshState {
    readonly lastRunAt: number | null;
    readonly lastRefreshed: readonly string[];
    readonly needsReauth: readonly string[];
}

export class CredentialRefreshScheduler {
    private timer: NodeJS.Timeout | undefined;
    private ticking = false;
    private lastRunAt: number | null = null;
    private lastRefreshed: string[] = [];
    private readonly needsReauth = new Set<string>();

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            void this.tick();
        }, CHECK_INTERVAL_MS);
        this.timer.unref();
        void this.tick();
        log.info(
            { intervalMs: CHECK_INTERVAL_MS, marginMs: REFRESH_MARGIN_MS },
            'credential refresh scheduler started',
        );
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    getState(): CredentialRefreshState {
        return {
            lastRunAt: this.lastRunAt,
            lastRefreshed: [...this.lastRefreshed],
            needsReauth: [...this.needsReauth],
        };
    }

    clearReauth(provider: string): void {
        this.needsReauth.delete(provider);
    }

    async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        const refreshed: string[] = [];
        try {
            for (const provider of listCredentialProviders()) {
                if (this.needsReauth.has(provider)) continue;

                let cred;
                try {
                    cred = loadCredential(provider);
                } catch {
                    continue;
                }
                if (!cred) continue;
                if (cred.expiresAt - Date.now() > REFRESH_MARGIN_MS) continue;

                if (!cred.refreshToken) {
                    this.needsReauth.add(provider);
                    log.warn(
                        { provider },
                        `credential near expiry with no refresh token — run \`flopsy auth ${provider}\` to re-authorize`,
                    );
                    continue;
                }

                try {
                    const next = await refreshCredentialNow(provider, {
                        skipIfFresherThanMs: REFRESH_MARGIN_MS,
                    });
                    refreshed.push(provider);
                    log.info(
                        { provider, expiresAt: next.expiresAt },
                        'proactively refreshed credential',
                    );
                } catch (err) {
                    if (isInvalidGrant(err)) {
                        this.needsReauth.add(provider);
                        log.warn(
                            { provider },
                            `refresh token invalid/revoked — run \`flopsy auth ${provider}\` to re-authorize`,
                        );
                    } else {
                        log.warn(
                            { provider, err: err instanceof Error ? err.message : String(err) },
                            'credential refresh failed (will retry next tick)',
                        );
                    }
                }
            }
            this.lastRefreshed = refreshed;
            this.lastRunAt = Date.now();
        } finally {
            this.ticking = false;
        }
    }
}
