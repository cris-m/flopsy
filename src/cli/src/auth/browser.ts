/**
 * Open a URL in the user's default browser.
 *
 * Cross-platform without an external dependency: use `open` on macOS,
 * `xdg-open` on Linux, and `start` on Windows. Fall back to printing
 * the URL — the CLI command that calls this ALWAYS also prints the URL,
 * so a spawn failure is a UX papercut, not a blocker.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export function openInBrowser(url: string): void {
    const plat = platform();
    const [cmd, args] =
        plat === 'darwin'
            ? ['open', [url]]
            : plat === 'win32'
                ? ['cmd', ['/c', 'start', '""', url]]
                : ['xdg-open', [url]];

    try {
        const child = spawn(cmd as string, args as string[], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        // Don't throw if the process later exits with a non-zero code —
        // many browsers exit immediately after they hand off to an existing
        // window, and we can't distinguish "failed" from "succeeded" reliably.
        child.on('error', () => {
            /* caller already printed the URL; fall back silently */
        });
    } catch {
        /* silent fallback — caller prints URL */
    }
}
