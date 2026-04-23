/**
 * PKCE (RFC 7636) helpers — code_verifier + code_challenge generation.
 *
 * This is what makes the OAuth flow safe for public / desktop clients:
 * the `code_verifier` never leaves our process, the server sees only its
 * SHA-256 hash (`code_challenge`). An attacker who intercepts the
 * authorization `code` can't exchange it without the verifier.
 *
 * We use S256 challenges (method="S256") — mandatory for modern
 * providers. Google, Notion, GitHub, Slack all support it.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
    readonly codeVerifier: string;
    readonly codeChallenge: string;
    readonly codeChallengeMethod: 'S256';
}

/**
 * Generate a fresh PKCE pair. Call once per authorization attempt —
 * the verifier MUST be unique per flow, otherwise replay attacks
 * become possible.
 *
 * Verifier: 32 random bytes → 43-char url-safe base64 (within RFC
 * 7636's 43-128 char bound).
 * Challenge: SHA-256(verifier) → url-safe base64, trimmed of padding.
 */
export function generatePkcePair(): PkcePair {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
    return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/**
 * OAuth `state` parameter — a nonce that ties the browser redirect back
 * to THIS flow. Our callback server verifies the returned state matches.
 * Without it, a malicious site could complete an auth flow against the
 * user's account and push the code into our local callback.
 *
 * 16 random bytes → 22-char url-safe base64. 128 bits of entropy — more
 * than enough to prevent guessing.
 */
export function generateState(): string {
    return randomBytes(16).toString('base64url');
}
