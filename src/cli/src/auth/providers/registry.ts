/**
 * Registry of supported auth providers. Adding a provider = import the
 * module + push it into `PROVIDERS`. The CLI auto-discovers everything
 * registered here for `flopsy auth <name>` + `flopsy auth list`.
 */

import type { AuthProvider } from '../types';
import {
    gmailProvider,
    driveProvider,
    calendarProvider,
    youtubeProvider,
    contactsProvider,
} from './google';
import { spotifyProvider } from './spotify';
import { twitterProvider } from './twitter';

// Per-service Google providers are the only entry points — the legacy combined
// `google` all-scopes flow was removed (each service writes its own credential
// file). A stale `google.json` from an old install still loads via refresh's
// legacy fallback; it just won't auto-refresh — re-auth the per-service provider.
export const PROVIDERS: readonly AuthProvider[] = [
    gmailProvider,
    driveProvider,
    calendarProvider,
    youtubeProvider,
    contactsProvider,
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
