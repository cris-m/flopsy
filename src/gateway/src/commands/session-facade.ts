/**
 * Bridge between the /new slash command and the team layer's
 * SessionResolver. Set by TeamHandler during startup.
 */

export interface SessionFacade {
    /**
     * Force-close the peer's current session and open a fresh one. Awaits
     * a single LLM extraction so the caller can show a recap in the
     * confirmation card. `rawKey` is the routing key.
     */
    forceNewSession(
        rawKey: string,
    ): Promise<{ sessionId: string; summary: string | null } | undefined>;
}

let facade: SessionFacade | null = null;

export function setSessionFacade(f: SessionFacade): void {
    facade = f;
}

export function getSessionFacade(): SessionFacade | null {
    return facade;
}
