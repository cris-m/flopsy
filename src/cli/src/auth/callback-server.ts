/**
 * Localhost HTTP callback server for OAuth authorization-code flows.
 *
 * Single-shot: binds to an ephemeral port (127.0.0.1:<random>), waits
 * for ONE request to `/callback`, extracts `code` + `state` from the
 * query string, closes itself, and resolves the promise.
 *
 * A 45-second timeout bounds the wait so a user who closes the browser
 * doesn't leave us hanging forever.
 *
 * Security notes:
 *   - bind address is 127.0.0.1 only (never 0.0.0.0) so no LAN exposure
 *   - the server accepts EXACTLY ONE request to /callback; anything else
 *     gets a 404 and doesn't resolve the promise
 *   - the `state` value is NOT verified here — the caller must compare
 *     it against what they generated, because only they know the expected
 *     value
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

const DEFAULT_TIMEOUT_MS = 45_000;

export interface CallbackResult {
    /** Authorization code from the OAuth provider. */
    readonly code: string;
    /** State parameter as returned by the provider (caller verifies). */
    readonly state: string;
    /** The exact redirect URI the callback used (for token-exchange echo). */
    readonly redirectUri: string;
}

export interface CallbackError {
    /** Provider's `error` query param (e.g., 'access_denied'). */
    readonly error: string;
    readonly errorDescription?: string;
    readonly state?: string;
}

/**
 * Open a callback listener. Resolves with the local redirect URI + a
 * `result` promise that fires on successful callback / timeout.
 *
 * The function is async because we must await `server.listen()` to
 * learn the ephemeral port assigned to us — Node's event loop is
 * single-threaded, so synchronous busy-waiting here would block the
 * very callback we're waiting for.
 */
export async function awaitOauthCallback(opts: {
    timeoutMs?: number;
    preferredPort?: number;
    path?: string;
    successHtml?: string;
    errorHtml?: (e: CallbackError) => string;
}): Promise<{ redirectUri: string; result: Promise<CallbackResult> }> {
    const path = opts.path ?? '/callback';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let resolvedRedirectUri = '';
    let resolveResult!: (v: CallbackResult) => void;
    let rejectResult!: (e: Error) => void;

    const result = new Promise<CallbackResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });

    const server: Server = createServer((req, res) => {
        if (!req.url) {
            res.statusCode = 400;
            res.end('bad request');
            return;
        }

        const url = new URL(req.url, resolvedRedirectUri);
        if (url.pathname !== path) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }

        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state') ?? undefined;
        if (error) {
            const errorDesc = url.searchParams.get('error_description') ?? undefined;
            const html = opts.errorHtml
                ? opts.errorHtml({ error, errorDescription: errorDesc, state })
                : defaultErrorHtml(error, errorDesc);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.statusCode = 400;
            res.end(html);
            cleanup();
            rejectResult(
                new Error(`OAuth error: ${error}${errorDesc ? ` — ${errorDesc}` : ''}`),
            );
            return;
        }

        const code = url.searchParams.get('code');
        if (!code || !state) {
            res.statusCode = 400;
            res.end('missing code or state');
            cleanup();
            rejectResult(new Error('OAuth callback missing code or state'));
            return;
        }

        const html = opts.successHtml ?? defaultSuccessHtml();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.statusCode = 200;
        res.end(html);
        cleanup();
        resolveResult({ code, state, redirectUri: resolvedRedirectUri });
    });

    const timer = setTimeout(() => {
        cleanup();
        rejectResult(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup(): void {
        clearTimeout(timer);
        server.close();
    }

    // Await the actual listen — port assignment happens here.
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.preferredPort ?? 0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            resolvedRedirectUri = `http://127.0.0.1:${addr.port}${path}`;
            resolve();
        });
    });

    return { redirectUri: resolvedRedirectUri, result };
}

function defaultSuccessHtml(): string {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>FlopsyBot — Authorized</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:10vh auto;padding:2em;color:#222;line-height:1.5}h1{font-size:1.4em;margin:0 0 0.5em}code{background:#f0f0f0;padding:2px 6px;border-radius:3px}</style>
</head><body>
<h1>Authorized</h1>
<p>FlopsyBot received your authorization. You can close this tab and return to your terminal.</p>
</body></html>`;
}

function defaultErrorHtml(error: string, description?: string): string {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>FlopsyBot — Authorization failed</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:10vh auto;padding:2em;color:#222;line-height:1.5}h1{font-size:1.4em;margin:0 0 0.5em;color:#c00}code{background:#f0f0f0;padding:2px 6px;border-radius:3px}</style>
</head><body>
<h1>Authorization failed</h1>
<p>Provider returned <code>${escapeHtml(error)}</code>${
        description ? `: ${escapeHtml(description)}` : ''
    }.</p>
<p>Close this tab and re-run the <code>flopsy auth</code> command to try again.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
