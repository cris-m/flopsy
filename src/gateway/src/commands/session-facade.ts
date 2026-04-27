/**
 * Module-level singleton bridging the /new slash command to the
 * TeamHandler's SessionResolver. Follows the same pattern as dnd-facade.ts.
 *
 * Set by TeamHandler during startup (setSessionFacade). Commands call
 * getSessionFacade()?.forceNewSession(rawKey) to force-rotate the active
 * session for a peer without the command layer needing to know about team
 * package internals.
 */

export interface SessionFacade {
    /**
     * Force-close the peer's current session and open a fresh one. The
     * `rawKey` is the peer routing key (`channel:scope:nativeId`) held by
     * the ChannelWorker — the same string passed as `threadId` to `invoke()`.
     *
     * Returns the new sessionId for display in the confirmation message.
     * Returns undefined if the session layer is not wired up.
     */
    forceNewSession(rawKey: string): string | undefined;
}

let facade: SessionFacade | null = null;

export function setSessionFacade(f: SessionFacade): void {
    facade = f;
}

export function getSessionFacade(): SessionFacade | null {
    return facade;
}
