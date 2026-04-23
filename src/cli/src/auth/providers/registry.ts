/**
 * Registry of supported auth providers. Adding a provider = import the
 * module + push it into `PROVIDERS`. The CLI auto-discovers everything
 * registered here for `flopsy auth <name>` + `flopsy auth list`.
 */

import type { AuthProvider } from '../types';
import { googleProvider } from './google';
import { spotifyProvider } from './spotify';
import { twitterProvider } from './twitter';

export const PROVIDERS: readonly AuthProvider[] = [googleProvider, spotifyProvider, twitterProvider];

export function getProvider(name: string): AuthProvider | undefined {
    const normalized = name.trim().toLowerCase();
    return PROVIDERS.find((p) => p.name === normalized);
}

export function providerNames(): string[] {
    return PROVIDERS.map((p) => p.name).sort();
}
