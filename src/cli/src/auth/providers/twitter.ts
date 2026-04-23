/**
 * Twitter/X auth provider — cookie-based via the `bird` CLI.
 *
 * Unlike Google/Spotify there is no OAuth token exchange here. Bird reads
 * cookies from your system browser. The `authorize()` flow:
 *   1. Verify bird CLI is installed (prompt to install if not)
 *   2. Run `bird check` — if already authenticated, save sentinel and done
 *   3. If not authenticated: print instructions to log into x.com, then poll
 *      `bird check` every 5 s for up to 3 minutes
 *   4. Write a sentinel credential to `<FLOPSY_HOME>/auth/twitter.json`
 *
 * The MCP server reads that file at startup to skip its own browser-open flow.
 * `refresh()` just re-runs the check — no token to exchange.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveCredential } from '../credential-store';
import { openInBrowser } from '../browser';
import type { AuthProvider, AuthorizeOptions, StoredCredential } from '../types';

const execFileAsync = promisify(execFile);

async function isBirdInstalled(): Promise<boolean> {
    try {
        await execFileAsync('npx', ['--yes', '@steipete/bird', '--version'], { timeout: 30_000 });
        return true;
    } catch {
        return false;
    }
}

async function birdCheck(): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync(
            'npx',
            ['--yes', '@steipete/bird', 'check'],
            { timeout: 30_000 },
        );
        return stdout.includes('Ready to tweet');
    } catch {
        return false;
    }
}

async function pollUntilAuthenticated(maxMs = 180_000, intervalMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    let attempt = 0;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalMs));
        attempt++;
        const remaining = Math.ceil((deadline - Date.now()) / 1000);
        process.stdout.write(`  Checking... (attempt ${attempt}, ${remaining}s remaining)\r`);
        if (await birdCheck()) return true;
    }
    return false;
}

function makeSentinel(displayName?: string): StoredCredential {
    const now = Date.now();
    return {
        provider: 'twitter',
        tokenType: 'cookie',
        // Not a real token — signals that bird verified cookies are present.
        accessToken: 'bird:cookie-auth',
        // Cookie-based auth has no expiry we can know; set far future so
        // `flopsy auth status` shows "valid" until the user explicitly revokes.
        expiresAt: now + 365 * 24 * 60 * 60 * 1000,
        scopes: ['read', 'write'],
        ...(displayName ? { displayName } : {}),
        authorizedAt: now,
    };
}

export const twitterProvider: AuthProvider = {
    name: 'twitter',
    displayName: 'Twitter/X (via bird CLI — cookie auth)',
    defaultScopes: ['read', 'write'],

    async authorize(_opts: AuthorizeOptions = {}): Promise<StoredCredential> {
        // 1. Ensure bird is available.
        const installed = await isBirdInstalled();
        if (!installed) {
            throw new Error(
                'bird CLI is not installed.\n' +
                    '  Run: npm install -g @steipete/bird\n' +
                    '  Then re-run: flopsy auth twitter\n',
            );
        }

        // 2. Fast path — already authenticated.
        if (await birdCheck()) {
            console.log('✓ Already authenticated with X/Twitter.');
            const cred = makeSentinel();
            saveCredential(cred);
            return cred;
        }

        // 3. Not authenticated — open the login page and poll.
        const loginUrl = 'https://x.com/login';
        console.log('\n  Twitter/X Authentication');
        console.log('  ────────────────────────────────────────────');
        console.log(`  Opening: ${loginUrl}`);
        console.log('  Log in to X/Twitter, then come back here.\n');
        openInBrowser(loginUrl);
        console.log('  Waiting up to 3 minutes...\n');

        const ok = await pollUntilAuthenticated();
        process.stdout.write('\n');

        if (!ok) {
            throw new Error(
                'Timed out waiting for X/Twitter login.\n' +
                    '  Make sure you are logged in to x.com in your browser,\n' +
                    '  then re-run: flopsy auth twitter\n',
            );
        }

        console.log('\n  ✓ Authenticated with X/Twitter!\n');
        const cred = makeSentinel();
        saveCredential(cred);
        return cred;
    },

    async refresh(current: StoredCredential): Promise<StoredCredential> {
        // Re-verify cookies are still valid; no token exchange needed.
        const ok = await birdCheck();
        if (!ok) {
            throw new Error(
                'X/Twitter cookies are no longer valid.\n' +
                    '  Log in to x.com in your browser, then run: flopsy auth twitter\n',
            );
        }
        // Bump the sentinel's expiresAt so status shows it as fresh.
        const refreshed: StoredCredential = {
            ...current,
            expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
        saveCredential(refreshed);
        return refreshed;
    },
};
