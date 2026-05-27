/**
 * Registry of supported auth providers. Adding a provider = import the
 * module + push it into `PROVIDERS`. The CLI auto-discovers everything
 * registered here for `flopsy auth <name>` + `flopsy auth list`.
 */

import type { AuthProvider } from '../types';
import {
    googleProvider,
    gmailProvider,
    driveProvider,
    calendarProvider,
    youtubeProvider,
    contactsProvider,
} from './google';
import { spotifyProvider } from './spotify';
import { twitterProvider } from './twitter';

// Per-service Google providers come first so `flopsy auth list` shows them
// as the recommended entry points. `googleProvider` (the legacy all-scopes
// flow) stays for backward-compat — re-running it overwrites only `google.json`,
// not the per-service files.
export const PROVIDERS: readonly AuthProvider[] = [
    gmailProvider,
    driveProvider,
    calendarProvider,
    youtubeProvider,
    contactsProvider,
    googleProvider,
    spotifyProvider,
    twitterProvider,
];

export function getProvider(name: string): AuthProvider | undefined {
    const normalized = name.trim().toLowerCase();
    return PROVIDERS.find((p) => p.name === normalized);
}

export function providerNames(): string[] {
    return PROVIDERS.map((p) => p.name).sort();
}
